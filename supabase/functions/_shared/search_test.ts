import { contractDetail, expandHit, expandHits, type SearchHit } from "./search.ts";

const denoTest = (Deno as typeof Deno & {
  test(name: string, fn: () => void | Promise<void>): void;
}).test;

function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, received ${actualJson}`);
  }
}

// Copied from a live response for "S50". The root carries the contracts; `exchange` is the
// display name and `source_id` is the usable ticker prefix.
const S50_ROOT: SearchHit = {
  symbol: "S50",
  description: "SET50 Index Futures",
  type: "futures",
  exchange: "TFEX",
  source_id: "TFEX",
  currency_code: "THB",
  country: "TH",
  contracts: [
    { symbol: "S501!", typespecs: ["continuous", "synthetic"] },
    { symbol: "S502!", typespecs: ["continuous", "synthetic"] },
    { symbol: "S50U2026", description: "Sep 2026" },
    { symbol: "S50Z2026", description: "Dec 2026" },
  ],
};

denoTest("a futures root expands into its contracts and is not itself offered", () => {
  const results = expandHit(S50_ROOT);
  // TFEX:S50 is refused by the chart socket as an invalid symbol, so it must never be listed.
  assertEquals(results.some((result) => result.ticker === "TFEX:S50"), false);
  assertEquals(results.map((result) => result.ticker), [
    "TFEX:S501!",
    "TFEX:S502!",
    "TFEX:S50U2026",
    "TFEX:S50Z2026",
  ]);
});

denoTest("each contract says whether it rolls or expires", () => {
  const byTicker = new Map(expandHit(S50_ROOT).map((result) => [result.ticker, result]));
  assertEquals(byTicker.get("TFEX:S501!")?.description, "SET50 Index Futures · continuous · front month");
  assertEquals(byTicker.get("TFEX:S501!")?.continuous, true);
  assertEquals(byTicker.get("TFEX:S502!")?.description, "SET50 Index Futures · continuous · contract 2");
  assertEquals(byTicker.get("TFEX:S50U2026")?.description, "SET50 Index Futures · Sep 2026");
  assertEquals(byTicker.get("TFEX:S50U2026")?.continuous, false);
  // The exchange and currency of the root carry over to every contract.
  assertEquals(byTicker.get("TFEX:S50Z2026")?.exchange, "TFEX");
  assertEquals(byTicker.get("TFEX:S50Z2026")?.currency, "THB");
});

denoTest("searching an exact contract code yields just that contract", () => {
  // What the service actually returns for "S50Z2026": the root, narrowed to the one match.
  const narrowed: SearchHit = { ...S50_ROOT, contracts: [{ symbol: "S50Z2026", description: "Dec 2026" }] };
  assertEquals(expandHit(narrowed).map((result) => result.ticker), ["TFEX:S50Z2026"]);
});

denoTest("an ordinary instrument is unchanged, and highlighting markup is stripped", () => {
  assertEquals(expandHit({
    symbol: "<em>PTT</em>",
    description: "<em>PTT</em> Public Co., Ltd.",
    type: "stock",
    exchange: "SET",
    source_id: "SET",
    currency_code: "THB",
  }), [{
    exchange: "SET",
    type: "stock",
    currency: "THB",
    country: null,
    ticker: "SET:PTT",
    symbol: "PTT",
    description: "PTT Public Co., Ltd.",
  }]);
});

denoTest("prefix wins over source_id, because that is the ticker TradingView uses", () => {
  const results = expandHit({ symbol: "BTCUSDT", exchange: "Binance", prefix: "BINANCE", source_id: "BINANCE" });
  assertEquals(results[0].ticker, "BINANCE:BTCUSDT");
  // `exchange` is a display name and would not resolve as a prefix, so it is shown, not used.
  assertEquals(results[0].exchange, "Binance");
});

denoTest("a hit with nothing usable is dropped rather than half-built", () => {
  assertEquals(expandHit({ symbol: "PTT" }), []); // no prefix
  assertEquals(expandHit({ source_id: "SET" }), []); // no symbol
  assertEquals(expandHit({ symbol: "S50", source_id: "TFEX", contracts: [{ symbol: "" }] }), []);
});

denoTest("expandHits de-duplicates across roots and stops at the limit", () => {
  // The same contract codes exist on more than one exchange; both are legitimate and distinct.
  const krx: SearchHit = { ...S50_ROOT, exchange: "KRX", source_id: "KRX", description: "SKH Futures" };
  const all = expandHits([S50_ROOT, krx], 30);
  assertEquals(all.length, 8);
  assertEquals(all[4].ticker, "KRX:S501!");
  // A repeated hit contributes nothing the second time.
  assertEquals(expandHits([S50_ROOT, S50_ROOT], 30).length, 4);
  assertEquals(expandHits([S50_ROOT, krx], 3).map((result) => result.ticker), [
    "TFEX:S501!",
    "TFEX:S502!",
    "TFEX:S50U2026",
  ]);
});

denoTest("the contract rank is read relative to a root that itself ends in digits", () => {
  // S501! is S50 contract 1, not contract 501: the naive regex reads the root's own digits.
  assertEquals(contractDetail({ symbol: "S501!", typespecs: ["continuous"] }, "S50").detail, "continuous · front month");
  assertEquals(contractDetail({ symbol: "S5012!", typespecs: ["continuous"] }, "S50").detail, "continuous · contract 12");
  // Without a root to subtract, the single trailing digit is the best available guess.
  assertEquals(contractDetail({ symbol: "ES1!", typespecs: ["continuous"] }).detail, "continuous · front month");
  assertEquals(contractDetail({ symbol: "ODD", typespecs: ["continuous"] }).detail, "continuous · contract ?");
  assertEquals(contractDetail({ symbol: "S50U2026", description: "Sep 2026" }, "S50"), {
    detail: "Sep 2026",
    continuous: false,
  });
});
