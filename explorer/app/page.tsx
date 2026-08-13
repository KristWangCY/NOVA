"use client";

import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type Denomination = {
  name: string;
  symbol: string;
  smallestUnit: string;
  decimals: number;
};

type Overview = {
  ok: boolean;
  name: string;
  chainId: string;
  validator: string;
  height: number;
  blockHash: string;
  blockTimeMs: number;
  validators: number;
  quorum: number;
  peers: number;
  mempoolSize: number;
  latestBlockTime: number;
  totalTransactions: number;
  totalRecords: number;
  totalSupply: string;
  burnedFees: string;
  accounts: number;
  denomination: Denomination;
  validatorSet: Array<{ name: string; address: string; url: string }>;
};

type TransferTransaction = {
  id: string;
  type: "transfer";
  from: string;
  to: string;
  amount: string;
  fee: string;
  nonce: number;
  memo: string;
};

type RecordTransaction = {
  id: string;
  type: "record";
  from: string;
  fee: string;
  nonce: number;
  hashAlgorithm: "sha256";
  contentHash: string;
  contentSize: number;
  title: string;
  category: string;
  note: string;
};

type Transaction = TransferTransaction | RecordTransaction;

type Receipt = {
  transactionId: string;
  status: "pending" | "committed" | "not_found";
  final: boolean;
  height?: number;
  blockHash?: string;
  timestamp?: number;
  transactionIndex?: number;
  transaction?: Transaction;
};

type Block = {
  header: {
    height: number;
    timestamp: number;
    proposer: string;
    transactionRoot: string;
    stateRoot: string;
  };
  hash: string;
  transactions: Transaction[];
  commit: { votes: Array<{ validator: string }> };
};

type AccountResult = {
  kind: "account";
  address: string;
  balance: string;
  nonce: number;
  height: number;
  transactions: Receipt[];
};

type SearchResult =
  | AccountResult
  | { kind: "transaction"; receipt: Receipt }
  | { kind: "block"; block: Block }
  | { kind: "records"; contentHash: string; fileName?: string; fileSize?: number; records: Receipt[] };

const DEFAULT_NODE = "http://127.0.0.1:4101";

function shorten(value: string, head = 8, tail = 6) {
  if (!value || value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function formatUnits(value: string, decimals = 6, fractionDigits = 2) {
  const amount = BigInt(value || "0");
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const fraction = (amount % scale)
    .toString()
    .padStart(decimals, "0")
    .slice(0, fractionDigits)
    .replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}

function relativeTime(timestamp?: number) {
  if (!timestamp) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 5) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

function digestToHex(digest: ArrayBuffer) {
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload as T;
}

function CopyButton({ value, label = "复制" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }
  return (
    <button className="copy-button" onClick={copy} type="button" aria-label={`${label} ${value}`}>
      {copied ? "已复制" : label}
    </button>
  );
}

export default function Home() {
  const [nodeUrl, setNodeUrl] = useState(DEFAULT_NODE);
  const [draftUrl, setDraftUrl] = useState(DEFAULT_NODE);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [transactions, setTransactions] = useState<Receipt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const [verifyingFile, setVerifyingFile] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);

  const api = useMemo(() => nodeUrl.replace(/\/$/, ""), [nodeUrl]);

  const loadDashboard = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const nextOverview = await fetchJson<Overview>(`${api}/overview`);
      const from = Math.max(0, nextOverview.height - 9);
      const [blockResult, transactionResult] = await Promise.all([
        fetchJson<{ blocks: Block[] }>(`${api}/blocks?from=${from}&limit=10`),
        fetchJson<{ transactions: Receipt[] }>(`${api}/transactions?limit=10`),
      ]);
      setOverview(nextOverview);
      setBlocks([...blockResult.blocks].reverse());
      setTransactions(transactionResult.transactions);
      setError(null);
      setLastUpdated(Date.now());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法连接节点");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    const stored = window.localStorage.getItem("nova-node-url");
    if (stored) {
      const restore = window.setTimeout(() => {
        setNodeUrl(stored);
        setDraftUrl(stored);
      }, 0);
      return () => window.clearTimeout(restore);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void loadDashboard(), 0);
    const timer = window.setInterval(() => void loadDashboard(true), 3000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [loadDashboard]);

  function connect(event: FormEvent) {
    event.preventDefault();
    const normalized = draftUrl.trim().replace(/\/$/, "");
    if (!/^http:\/\/(localhost|127\.0\.0\.1)(:[0-9]+)?$/.test(normalized)) {
      setError("当前安全策略只允许连接本机 localhost 或 127.0.0.1 节点");
      return;
    }
    window.localStorage.setItem("nova-node-url", normalized);
    setNodeUrl(normalized);
  }

  async function submitSearch(event: FormEvent) {
    event.preventDefault();
    const query = search.trim();
    if (!query) return;
    setSearching(true);
    setSearchError(null);
    setSearchResult(null);
    try {
      if (/^nova1[0-9a-f]{40}$/.test(query)) {
        const [account, history] = await Promise.all([
          fetchJson<Omit<AccountResult, "kind" | "transactions">>(`${api}/accounts/${query}`),
          fetchJson<{ transactions: Receipt[] }>(`${api}/transactions?limit=50&address=${query}`),
        ]);
        setSearchResult({ kind: "account", ...account, transactions: history.transactions });
      } else if (/^[0-9]+$/.test(query)) {
        const result = await fetchJson<{ block: Block }>(`${api}/blocks/${query}`);
        setSearchResult({ kind: "block", block: result.block });
      } else if (/^[0-9a-f]{64}$/.test(query)) {
        const receipt = await fetchJson<Receipt>(`${api}/transactions/${query}`);
        if (receipt.status !== "not_found") {
          setSearchResult({ kind: "transaction", receipt });
        } else {
          try {
            const result = await fetchJson<{ block: Block }>(`${api}/blocks/${query}`);
            setSearchResult({ kind: "block", block: result.block });
          } catch {
            const result = await fetchJson<{ records: Receipt[] }>(`${api}/records?hash=${query}&limit=100`);
            if (result.records.length === 0) throw new Error("未找到对应的交易、区块或文件存证");
            setSearchResult({ kind: "records", contentHash: query, records: result.records });
          }
        }
      } else {
        throw new Error("请输入区块高度、交易/区块/文件哈希或 nova1 地址");
      }
    } catch (caught) {
      setSearchError(caught instanceof Error ? caught.message : "未找到结果");
    } finally {
      setSearching(false);
    }
  }

  async function verifyLocalFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setVerifyingFile(true);
    setSearchError(null);
    setSearchResult(null);
    try {
      if (file.size > 64 * 1024 * 1024) {
        throw new Error("浏览器验证上限为 64 MiB；更大的文件请使用 CLI 流式验证");
      }
      const digest = await window.crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      const contentHash = digestToHex(digest);
      setSearch(contentHash);
      const result = await fetchJson<{ records: Receipt[] }>(`${api}/records?hash=${contentHash}&limit=100`);
      const records = result.records.filter(
        ({ transaction }) => transaction?.type === "record" && transaction.contentSize === file.size,
      );
      if (records.length === 0) throw new Error("这个文件尚未在当前 NOVA 链上找到匹配存证");
      setSearchResult({ kind: "records", contentHash, fileName: file.name, fileSize: file.size, records });
    } catch (caught) {
      setSearchError(caught instanceof Error ? caught.message : "文件验证失败");
    } finally {
      setVerifyingFile(false);
    }
  }

  const decimals = overview?.denomination.decimals ?? 6;
  const symbol = overview?.denomination.symbol ?? "NOVA";
  const connected = Boolean(overview && !error);

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="NOVA Explorer 首页">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>NOVA</span>
          <small>EXPLORER / 02</small>
        </a>
        <form className="node-connect" onSubmit={connect}>
          <span className={`status-dot ${connected ? "online" : "offline"}`} />
          <label htmlFor="node-url">节点</label>
          <input
            id="node-url"
            value={draftUrl}
            onChange={(event) => setDraftUrl(event.target.value)}
            spellCheck={false}
            aria-label="NOVA 节点地址"
          />
          <button type="submit">连接</button>
        </form>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <div className="eyebrow"><span>LOCAL SOVEREIGN NETWORK</span><b>{connected ? "节点在线" : "等待节点"}</b></div>
          <h1>看见每一次<br /><em>共识发生。</em></h1>
          <p>你的 NOVA 私有网络，此刻的区块、交易、文件存证与账户状态。数据直接来自本机验证节点。</p>
          <form className="search-bar" onSubmit={submitSearch}>
            <span aria-hidden="true">⌕</span>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索区块高度 / 交易、区块或文件哈希 / nova1 地址"
              aria-label="搜索链上数据"
            />
            <button disabled={searching || !connected} type="submit">{searching ? "查询中" : "探索"}</button>
          </form>
          <div className="file-verifier">
            <label>
              <input type="file" onChange={(event) => void verifyLocalFile(event)} disabled={verifyingFile || !connected} />
              <span>{verifyingFile ? "正在本地计算…" : "验证本地文件"}</span>
            </label>
            <small>文件不会上传；浏览器只计算 SHA-256。最大 64 MiB。</small>
          </div>
          {searchError && <p className="inline-error" role="alert">{searchError}</p>}
        </div>
        <div className="height-panel">
          <span className="panel-label">LATEST BLOCK</span>
          <strong>{overview ? overview.height.toLocaleString("en-US") : "—"}</strong>
          <div className="height-meta">
            <span><i />{overview
              ? overview.mempoolSize === 0
                ? `节点在线 · 正常空闲 · 最新区块 ${relativeTime(overview.latestBlockTime)}`
                : `等待共识 · ${overview.mempoolSize} PENDING`
              : "等待连接"}</span>
            <span>{overview ? `${overview.quorum}/${overview.validators} QUORUM` : "—"}</span>
          </div>
          <div className="hash-line">
            <code>{overview ? shorten(overview.blockHash, 15, 10) : "no block hash"}</code>
            {overview && <CopyButton value={overview.blockHash} />}
          </div>
        </div>
      </section>

      {error && (
        <section className="connection-error" role="alert">
          <div><b>尚未连接 NOVA 节点</b><span>{error}</span></div>
          <button onClick={() => void loadDashboard()} type="button">重新连接</button>
        </section>
      )}

      {searchResult && (
        <section className="search-result" aria-live="polite">
          <div className="section-heading">
            <div><span>SEARCH RESULT</span><h2>{searchResult.kind === "account" ? "账户详情" : searchResult.kind === "block" ? "区块详情" : searchResult.kind === "records" ? "文件存证" : "交易回执"}</h2></div>
            <button type="button" onClick={() => setSearchResult(null)}>关闭</button>
          </div>
          {searchResult.kind === "account" && (
            <div className="result-grid">
              <div className="result-primary"><span>余额</span><strong>{formatUnits(searchResult.balance, decimals, 6)} <small>{symbol}</small></strong></div>
              <dl><div><dt>地址</dt><dd><code>{shorten(searchResult.address, 16, 12)}</code><CopyButton value={searchResult.address} /></dd></div><div><dt>Nonce</dt><dd>{searchResult.nonce}</dd></div><div><dt>交易数</dt><dd>{searchResult.transactions.length}</dd></div></dl>
            </div>
          )}
          {searchResult.kind === "transaction" && <TransactionDetail receipt={searchResult.receipt} decimals={decimals} symbol={symbol} />}
          {searchResult.kind === "block" && <BlockDetail block={searchResult.block} />}
          {searchResult.kind === "records" && <RecordMatches result={searchResult} />}
        </section>
      )}

      <section className="metrics" aria-label="网络指标">
        <Metric index="01" label="流通供应" value={overview ? formatUnits(overview.totalSupply, decimals) : "—"} suffix={symbol} />
        <Metric index="02" label="已确认活动" value={overview?.totalTransactions.toLocaleString("en-US") ?? "—"} suffix="TX" />
        <Metric index="03" label="验证节点" value={overview?.validators.toString() ?? "—"} suffix={`${overview?.peers ?? "—"} PEERS`} />
        <Metric index="04" label="文件存证" value={overview?.totalRecords.toLocaleString("en-US") ?? "—"} suffix={`${overview?.mempoolSize ?? "—"} PENDING`} accent />
      </section>

      <section className="ledger-grid">
        <div className="data-panel blocks-panel">
          <div className="section-heading">
            <div><span>BLOCK STREAM</span><h2>最近区块</h2></div>
            <small>{loading ? "同步中" : "每 3 秒同步"}</small>
          </div>
          <div className="table-head blocks-row"><span>高度</span><span>提议者</span><span>交易</span><span>时间</span></div>
          <div className="data-list">
            {blocks.map((block) => (
              <button className="blocks-row data-row" key={block.hash} type="button" onClick={() => setSearchResult({ kind: "block", block })}>
                <b>#{block.header.height}</b>
                <code>{block.header.proposer === "genesis" ? "GENESIS" : shorten(block.header.proposer)}</code>
                <span>{block.transactions.length}</span>
                <time>{relativeTime(block.header.timestamp)}</time>
              </button>
            ))}
            {!loading && blocks.length === 0 && <EmptyState label="还没有区块" />}
          </div>
        </div>

        <div className="data-panel transactions-panel">
          <div className="section-heading">
            <div><span>FINALIZED ACTIVITY</span><h2>最近交易</h2></div>
            <small>{transactions.length} 条</small>
          </div>
          <div className="data-list transaction-list">
            {transactions.map((receipt) => <ActivityRow key={receipt.transactionId} receipt={receipt} decimals={decimals} symbol={symbol} onOpen={() => setSearchResult({ kind: "transaction", receipt })} />)}
            {!loading && transactions.length === 0 && <EmptyState label="等待第一笔交易" />}
          </div>
        </div>
      </section>

      <section className="network-strip">
        <div><span>CHAIN ID</span><code>{overview?.chainId ?? "nova-local-1"}</code></div>
        <div><span>ACTIVE NODE</span><code>{overview?.name ?? "—"} / {shorten(overview?.validator ?? "")}</code></div>
        <div><span>BURNED FEES</span><b>{overview ? formatUnits(overview.burnedFees, decimals, 6) : "—"} {symbol}</b></div>
        <div><span>LAST SYNC</span><b>{lastUpdated ? relativeTime(lastUpdated) : "—"}</b></div>
      </section>

      <footer>
        <div><span className="brand-mark small" aria-hidden="true"><i /><i /><i /></span><b>NOVA</b></div>
        <p>本地、自主、可验证。当前为测试网络，请勿承载真实资产。</p>
        <code>EXPLORER v0.6.0</code>
      </footer>
    </main>
  );
}

function Metric({ index, label, value, suffix, accent = false }: { index: string; label: string; value: string; suffix: string; accent?: boolean }) {
  return <article className={`metric-card ${accent ? "accent" : ""}`}><span>{index} / {label}</span><div><strong>{value}</strong><small>{suffix}</small></div></article>;
}

function EmptyState({ label }: { label: string }) {
  return <div className="empty-state"><i /><span>{label}</span></div>;
}

function ActivityRow({ receipt, decimals, symbol, onOpen }: { receipt: Receipt; decimals: number; symbol: string; onOpen: () => void }) {
  const transaction = receipt.transaction;
  const record = transaction?.type === "record" ? transaction : null;
  const transfer = transaction?.type === "transfer" ? transaction : null;
  return <button className="transaction-row" type="button" onClick={onOpen}>
    <span className={`tx-icon ${record ? "record" : ""}`} aria-hidden="true">{record ? "#" : "↗"}</span>
    <div><b>{record ? record.title : `${formatUnits(transfer?.amount ?? "0", decimals, 4)} ${symbol}`}</b><code>{shorten(receipt.transactionId)}</code></div>
    <div>{record ? <><span>{record.category}</span><i>·</i><span>{shorten(record.from)}</span></> : <><span>{shorten(transfer?.from ?? "")}</span><i>→</i><span>{shorten(transfer?.to ?? "")}</span></>}</div>
    <time>{relativeTime(receipt.timestamp)}</time>
  </button>;
}

function RecordMatches({ result }: { result: Extract<SearchResult, { kind: "records" }> }) {
  return <div className="record-result">
    <div className="result-primary">
      <span>{result.fileName ? "本地文件已验证" : "匹配存证"}</span>
      <strong className="final-status">{result.records.length} MATCH</strong>
      {result.fileName && <small>{result.fileName} · {formatBytes(result.fileSize ?? 0)}</small>}
    </div>
    <div className="record-matches">
      <div className="record-hash"><span>SHA-256</span><code>{shorten(result.contentHash, 18, 14)}</code><CopyButton value={result.contentHash} /></div>
      {result.records.map((receipt) => {
        const record = receipt.transaction?.type === "record" ? receipt.transaction : null;
        if (!record) return null;
        return <article key={receipt.transactionId}>
          <div><b>{record.title}</b><span>{record.category} · {formatBytes(record.contentSize)}</span></div>
          <p>{record.note || "无公开备注"}</p>
          <div><code>#{receipt.height} · {shorten(receipt.transactionId, 14, 10)}</code><time>{receipt.timestamp ? new Date(receipt.timestamp).toLocaleString("zh-CN") : "—"}</time></div>
        </article>;
      })}
    </div>
  </div>;
}

function TransactionDetail({ receipt, decimals, symbol }: { receipt: Receipt; decimals: number; symbol: string }) {
  const tx = receipt.transaction;
  if (tx?.type === "record") {
    return <div className="detail-grid">
      <div className="result-primary"><span>存证状态</span><strong className="final-status">{receipt.final ? "VERIFIED / 已确认" : receipt.status.toUpperCase()}</strong></div>
      <dl>
        <div><dt>交易哈希</dt><dd><code>{shorten(receipt.transactionId, 16, 12)}</code><CopyButton value={receipt.transactionId} /></dd></div>
        <div><dt>区块</dt><dd>#{receipt.height ?? "—"}</dd></div>
        <div><dt>标题</dt><dd>{tx.title}</dd></div>
        <div><dt>分类</dt><dd>{tx.category}</dd></div>
        <div><dt>文件大小</dt><dd>{formatBytes(tx.contentSize)}</dd></div>
        <div><dt>SHA-256</dt><dd><code>{shorten(tx.contentHash, 16, 12)}</code><CopyButton value={tx.contentHash} /></dd></div>
        <div><dt>记录者</dt><dd><code>{shorten(tx.from, 12, 10)}</code></dd></div>
        <div><dt>公开备注</dt><dd>{tx.note || "—"}</dd></div>
        <div><dt>手续费</dt><dd>{formatUnits(tx.fee, decimals, 6)} {symbol}</dd></div>
      </dl>
    </div>;
  }
  const transfer = tx?.type === "transfer" ? tx : null;
  return <div className="detail-grid">
    <div className="result-primary"><span>状态</span><strong className="final-status">{receipt.final ? "FINAL / 已确认" : receipt.status.toUpperCase()}</strong></div>
    <dl>
      <div><dt>交易哈希</dt><dd><code>{shorten(receipt.transactionId, 16, 12)}</code><CopyButton value={receipt.transactionId} /></dd></div>
      <div><dt>区块</dt><dd>#{receipt.height ?? "—"}</dd></div>
      <div><dt>金额</dt><dd>{transfer ? formatUnits(transfer.amount, decimals, 6) : "—"} {symbol}</dd></div>
      <div><dt>发送方</dt><dd><code>{shorten(transfer?.from ?? "", 12, 10)}</code></dd></div>
      <div><dt>接收方</dt><dd><code>{shorten(transfer?.to ?? "", 12, 10)}</code></dd></div>
      <div><dt>备注</dt><dd>{transfer?.memo || "—"}</dd></div>
    </dl>
  </div>;
}

function BlockDetail({ block }: { block: Block }) {
  return <div className="detail-grid">
    <div className="result-primary"><span>区块高度</span><strong>#{block.header.height}</strong></div>
    <dl>
      <div><dt>区块哈希</dt><dd><code>{shorten(block.hash, 16, 12)}</code><CopyButton value={block.hash} /></dd></div>
      <div><dt>时间</dt><dd>{new Date(block.header.timestamp).toLocaleString("zh-CN")}</dd></div>
      <div><dt>交易数</dt><dd>{block.transactions.length}</dd></div>
      <div><dt>提交签名</dt><dd>{block.commit.votes.length}</dd></div>
      <div><dt>状态根</dt><dd><code>{shorten(block.header.stateRoot, 16, 12)}</code></dd></div>
      <div><dt>交易根</dt><dd><code>{shorten(block.header.transactionRoot, 16, 12)}</code></dd></div>
    </dl>
  </div>;
}
