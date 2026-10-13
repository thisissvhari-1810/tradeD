function xml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function tradeReceiptSvg(input: {
  symbol: string;
  name: string;
  exchange: string;
  quantity: number;
  entry: string;
  exit: string;
  entryAt: string;
  exitAt: string;
  gross: string;
  charges: string;
  net: string;
  ret: string;
  profit: boolean;
}) {
  const tone = input.profit ? "#10B981" : input.net.startsWith("-") ? "#EF4444" : "#F8FAFC";
  const rows = [
    ["Quantity", String(input.quantity)],
    ["Average entry", input.entry],
    ["Average exit", input.exit],
    ["Opened", input.entryAt],
    ["Closed", input.exitAt],
    ["Gross P&L", input.gross],
    ["Charges", input.charges],
    ["Net P&L", input.net],
    ["Return", input.ret],
  ];
  const lines = rows.map((row, index) => {
    const y = 118 + index * 28;
    const color = row[0] === "Net P&L" || row[0] === "Return" ? tone : "#F8FAFC";
    return `<text x="28" y="${y}" fill="#94A3B8" font-size="13">${xml(row[0])}</text><text x="692" y="${y}" fill="${color}" font-size="13" text-anchor="end" font-family="ui-monospace, monospace">${xml(row[1])}</text>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="720" height="420" viewBox="0 0 720 420">
  <rect width="720" height="420" fill="#0A0D14"/>
  <rect x="12" y="12" width="696" height="396" fill="#141A26" stroke="#243044"/>
  <text x="28" y="48" fill="#94A3B8" font-size="12" font-family="sans-serif">TRADELAB PAPER TRADE · VIRTUAL MONEY</text>
  <text x="28" y="78" fill="#F8FAFC" font-size="22" font-family="sans-serif">${xml(input.symbol)} closed</text>
  <text x="28" y="100" fill="#94A3B8" font-size="13" font-family="sans-serif">${xml(input.name)} · ${xml(input.exchange)} · LONG</text>
  ${lines}
  <text x="28" y="392" fill="#94A3B8" font-size="11" font-family="sans-serif">Saved from the confirmed fill. This receipt is not a broker contract.</text>
</svg>`;
}
