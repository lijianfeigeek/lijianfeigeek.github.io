/**
 * Gridea Full-Text Search Web Worker
 * 在独立后台线程拉取、缓存并检索 L2 正文分片，确保主线程输入框 120fps 零掉帧
 */

let indexVersion = '';
let totalChunks = 0;
let basePath = '';
const chunkCache = new Map(); // chunkIdx -> Array<{ i, body, bodyLower, combinedLower }>
const inflightChunks = new Map(); // chunkIdx -> Promise
let activeReqId = 0;

function loadChunk(cIdx) {
  if (chunkCache.has(cIdx)) {
    return Promise.resolve(chunkCache.get(cIdx));
  }
  if (inflightChunks.has(cIdx)) {
    return inflightChunks.get(cIdx);
  }
  const url = `${basePath}/search-chunks/chunk-${cIdx}.json${indexVersion ? '?v=' + indexVersion : ''}`;
  const p = fetch(url)
    .then(res => {
      if (!res.ok) throw new Error('Chunk load failed: ' + cIdx);
      return res.json();
    })
    .then(data => {
      const parsed = (data.items || []).map(entry => {
        const postIdx = entry[0];
        const body = entry[1] || '';
        const prefix = entry[2] || '';
        const bodyLower = body.toLowerCase();
        const combinedLower = (prefix ? prefix.toLowerCase() + ' ' : '') + bodyLower;
        return {
          i: postIdx,
          body,
          bodyLower,
          combinedLower
        };
      });
      chunkCache.set(cIdx, parsed);
      inflightChunks.delete(cIdx);
      return parsed;
    })
    .catch(err => {
      inflightChunks.delete(cIdx);
      throw err;
    });

  inflightChunks.set(cIdx, p);
  return p;
}

function buildSnippet(body, bodyLower, orderedTokens, rawPhraseLower) {
  if (!body) return '';
  let hitPos = -1;
  if (rawPhraseLower && rawPhraseLower.length > 1) {
    hitPos = bodyLower.indexOf(rawPhraseLower);
  }
  if (hitPos === -1) {
    for (let k = 0; k < orderedTokens.length; k++) {
      const p = bodyLower.indexOf(orderedTokens[k]);
      if (p !== -1) {
        hitPos = p;
        break;
      }
    }
  }
  if (hitPos === -1) {
    return body.slice(0, 110) + (body.length > 110 ? '…' : '');
  }
  const start = Math.max(0, hitPos - 36);
  const end = Math.min(body.length, hitPos + 82);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < body.length ? '…' : '';
  return prefix + body.slice(start, end).trim() + suffix;
}

function scanChunkItems(entries, orderedTokens, rawPhraseLower) {
  const hits = [];
  const tokenCount = orderedTokens.length;

  for (let idx = 0; idx < entries.length; idx++) {
    const entry = entries[idx];
    const haystack = entry.combinedLower;

    // 按最长词优先短路检查：不满足全部词 AND 交集直接跳过
    let matchedAll = true;
    for (let t = 0; t < tokenCount; t++) {
      if (haystack.indexOf(orderedTokens[t]) === -1) {
        matchedAll = false;
        break;
      }
    }
    if (!matchedAll) continue;

    // 统计正文命中频次作为相关性微调权重
    let freq = 0;
    const primaryToken = orderedTokens[0];
    let pos = entry.bodyLower.indexOf(primaryToken);
    let count = 0;
    while (pos !== -1 && count < 6) {
      count++;
      pos = entry.bodyLower.indexOf(primaryToken, pos + primaryToken.length);
    }
    freq = count;

    const phraseBonus =
      rawPhraseLower.length > 1 && entry.bodyLower.indexOf(rawPhraseLower) !== -1 ? 12 : 0;

    hits.push({
      i: entry.i,
      score: 12 + freq * 2 + phraseBonus,
      snippet: buildSnippet(entry.body, entry.bodyLower, orderedTokens, rawPhraseLower)
    });
  }
  return hits;
}

async function handleBodySearch(msg) {
  const { reqId, tokens, rawQuery } = msg;
  activeReqId = reqId;

  if (!tokens || !tokens.length || totalChunks <= 0) {
    self.postMessage({
      type: 'BODY_BATCH',
      reqId,
      hits: [],
      loadedCount: chunkCache.size,
      totalChunks,
      done: true
    });
    return;
  }

  // 将较长的特征词排在最前面，极大加速 indexOf 短路过滤
  const orderedTokens = tokens.slice().sort((a, b) => b.length - a.length);
  const rawPhraseLower = String(rawQuery || '').trim().toLowerCase();

  // 1. 先零延迟同步扫描已在内存中的分片
  const cachedHits = [];
  const missingIndices = [];
  for (let c = 0; c < totalChunks; c++) {
    if (chunkCache.has(c)) {
      const part = scanChunkItems(chunkCache.get(c), orderedTokens, rawPhraseLower);
      for (let j = 0; j < part.length; j++) cachedHits.push(part[j]);
    } else {
      missingIndices.push(c);
    }
  }

  if (activeReqId !== reqId) return;

  if (missingIndices.length === 0) {
    self.postMessage({
      type: 'BODY_BATCH',
      reqId,
      hits: cachedHits,
      loadedCount: totalChunks,
      totalChunks,
      done: true
    });
    return;
  }

  // 先把已缓存分片的命中结果立刻推回主线程
  if (cachedHits.length > 0) {
    self.postMessage({
      type: 'BODY_BATCH',
      reqId,
      hits: cachedHits,
      loadedCount: chunkCache.size,
      totalChunks,
      done: false
    });
  }

  // 2. 控制并发度 (3 路并行) 流式拉取剩余分片，按时间从新到旧扫描
  let cursor = 0;
  let completedMissing = 0;
  const concurrency = Math.min(3, missingIndices.length);

  async function workerLoop() {
    while (cursor < missingIndices.length) {
      if (activeReqId !== reqId) return;
      const cIdx = missingIndices[cursor++];
      try {
        const entries = await loadChunk(cIdx);
        completedMissing++;
        if (activeReqId !== reqId) return;
        const partHits = scanChunkItems(entries, orderedTokens, rawPhraseLower);
        const isAllDone = completedMissing >= missingIndices.length;
        self.postMessage({
          type: 'BODY_BATCH',
          reqId,
          hits: partHits,
          loadedCount: chunkCache.size,
          totalChunks,
          done: isAllDone
        });
      } catch (e) {
        completedMissing++;
        if (activeReqId === reqId && completedMissing >= missingIndices.length) {
          self.postMessage({
            type: 'BODY_BATCH',
            reqId,
            hits: [],
            loadedCount: chunkCache.size,
            totalChunks,
            done: true
          });
        }
      }
    }
  }

  const runners = [];
  for (let w = 0; w < concurrency; w++) {
    runners.push(workerLoop());
  }
  await Promise.all(runners);
}

self.onmessage = function (e) {
  const msg = e.data || {};
  if (msg.type === 'INIT') {
    basePath = msg.basePath || '';
    indexVersion = msg.version || '';
    totalChunks = msg.chunkCount || 0;
    if (msg.prewarmFirst && totalChunks > 0) {
      loadChunk(0).catch(() => {});
    }
  } else if (msg.type === 'PREWARM_ALL') {
    // 用户打开全文搜索框准备输入时，轻度预热前 2 个最新分片
    const limit = Math.min(2, totalChunks);
    for (let c = 0; c < limit; c++) {
      loadChunk(c).catch(() => {});
    }
  } else if (msg.type === 'SEARCH_BODY') {
    handleBodySearch(msg);
  }
};
