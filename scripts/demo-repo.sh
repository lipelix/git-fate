#!/bin/bash
# Creates a small repository with several authors over three years, for screenshots and manual testing.
# Usage: scripts/demo-repo.sh <empty-or-missing-dir>
set -euo pipefail
R="${1:?usage: demo-repo.sh <dir>}"
mkdir -p "$R/src"
cd "$R"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
git init -q -b main
git config user.name "Dana Novak"
git config user.email dana@example.com
git remote add origin git@github.com:example/shop-cart.git

c() {
  git add -A
  GIT_AUTHOR_NAME="$1" GIT_AUTHOR_EMAIL="$2" GIT_AUTHOR_DATE="$3" \
    GIT_COMMITTER_NAME="$1" GIT_COMMITTER_EMAIL="$2" GIT_COMMITTER_DATE="$3" \
    git commit -q -m "$4"
}

cat > src/cart.ts <<'TS'
export interface Item {
  sku: string;
  price: number;
  quantity: number;
}

export class Cart {
  private items: Item[] = [];

  add(item: Item): void {
    this.items.push(item);
  }

  total(): number {
    return this.items.reduce((sum, i) => sum + i.price * i.quantity, 0);
  }
}
TS
c "Martin Kral" martin@example.com 2023-02-14T09:00:00Z "Add shopping cart"

perl -0pi -e 's/    this\.items\.push\(item\);/    const existing = this.items.find((i) => i.sku === item.sku);\n    if (existing) {\n      existing.quantity += item.quantity;\n      return;\n    }\n    this.items.push(item);/' src/cart.ts
c "Eva Svobodova" eva@example.com 2024-05-20T13:30:00Z "Merge quantities of the same SKU

Adding an item that is already in the cart used to create a second row."

cat >> src/cart.ts <<'TS'

export function formatPrice(value: number, currency = 'CZK'): string {
  return new Intl.NumberFormat('cs-CZ', { style: 'currency', currency }).format(value);
}
TS
c "Tomas Dvorak" tomas@example.com 2025-09-02T08:10:00Z "Add price formatting helper"

perl -0pi -e 's/    return this\.items\.reduce\(\(sum, i\) => sum \+ i\.price \* i\.quantity, 0\);/    const subtotal = this.items.reduce((sum, i) => sum + i.price * i.quantity, 0);\n    return Math.round(subtotal * 100) \/ 100;/' src/cart.ts
c "Eva Svobodova" eva@example.com 2026-10-30T16:45:00Z "Round cart total to cents (#42)"

perl -0pi -e 's/  private items: Item\[\] = \[\];/  private readonly items: Item[] = [];/' src/cart.ts
c "Dana Novak" dana@example.com 2026-11-21T10:05:00Z "Make cart items readonly"
