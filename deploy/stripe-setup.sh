#!/bin/sh
# One-time Stripe setup for the portal, run on the server from deploy/: creates the Team product and its $50/month
# price and the webhook endpoint the portal listens on, and writes STRIPE_PRICE_TEAM and STRIPE_WEBHOOK_SECRET into
# .env. Needs STRIPE_SECRET_KEY and PORTAL_HOST already in .env. Idempotent: an existing product, price, or endpoint
# is reused. Prints ids only, never a secret. Then: docker compose --profile public up -d portal
set -eu
cd "$(dirname "$0")"
[ -f .env ] || { echo "no .env here" >&2; exit 1; }
STRIPE_SECRET_KEY=$(sed -n 's/^STRIPE_SECRET_KEY=//p' .env | tail -1)
PORTAL_HOST=$(sed -n 's/^PORTAL_HOST=//p' .env | tail -1)
[ -n "$STRIPE_SECRET_KEY" ] || { echo "STRIPE_SECRET_KEY is not in .env; add it with: read -s k && printf 'STRIPE_SECRET_KEY=%s\\n' \"\$k\" >> .env && unset k" >&2; exit 1; }
[ -n "$PORTAL_HOST" ] || { echo "PORTAL_HOST is not in .env" >&2; exit 1; }
export STRIPE_SECRET_KEY PORTAL_HOST
out=$(python3 - <<'PY'
import json, os, sys, urllib.parse, urllib.request
key = os.environ["STRIPE_SECRET_KEY"]; host = os.environ["PORTAL_HOST"]
def api(method, path, data=None):
    body = urllib.parse.urlencode(data, doseq=True).encode() if data is not None else None
    req = urllib.request.Request("https://api.stripe.com/v1/" + path, data=body, method=method, headers={"Authorization": "Bearer " + key})
    try:
        with urllib.request.urlopen(req, timeout=20) as r: return json.load(r)
    except urllib.error.HTTPError as e:
        sys.stderr.write("stripe %s %s: %s\n" % (method, path, e.read().decode()[:300])); sys.exit(1)
mode = "test" if key.startswith("sk_test_") or key.startswith("rk_test_") else "live"
# product and price
products = [p for p in api("GET", "products?active=true&limit=100")["data"] if p["name"] == "agent-custody Team"]
product = products[0] if products else api("POST", "products", {"name": "agent-custody Team", "description": "A million appends a month on the hosted log, email support within two working days."})
prices = [p for p in api("GET", "prices?product=%s&active=true&limit=100" % product["id"])["data"] if p.get("recurring", {}).get("interval") == "month" and p["currency"] == "usd" and p["unit_amount"] == 5000]
price = prices[0] if prices else api("POST", "prices", {"product": product["id"], "currency": "usd", "unit_amount": 5000, "recurring[interval]": "month", "nickname": "Team, monthly"})
# webhook endpoint: the signing secret is only returned at creation
url = "https://%s/stripe/webhook" % host
events = ["checkout.session.completed", "customer.subscription.updated", "customer.subscription.deleted"]
existing = [w for w in api("GET", "webhook_endpoints?limit=100")["data"] if w["url"] == url and w["status"] == "enabled"]
if existing:
    wh = existing[0]; secret = None
else:
    wh = api("POST", "webhook_endpoints", {"url": url, "enabled_events[]": events, "description": "agent-custody portal"}); secret = wh.get("secret")
print("MODE=" + mode); print("PRODUCT=" + product["id"]); print("PRICE=" + price["id"]); print("WEBHOOK=" + wh["id"])
if secret: print("WHSEC=" + secret)
PY
)
mode=$(printf '%s\n' "$out" | sed -n 's/^MODE=//p'); product=$(printf '%s\n' "$out" | sed -n 's/^PRODUCT=//p'); price=$(printf '%s\n' "$out" | sed -n 's/^PRICE=//p'); wh=$(printf '%s\n' "$out" | sed -n 's/^WEBHOOK=//p'); whsec=$(printf '%s\n' "$out" | sed -n 's/^WHSEC=//p')
setenv() { if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi; }
setenv STRIPE_PRICE_TEAM "$price"
if [ -n "$whsec" ]; then setenv STRIPE_WEBHOOK_SECRET "$whsec"; wrote="written to .env"; else wrote=$(grep -q '^STRIPE_WEBHOOK_SECRET=.\+' .env && echo "already in .env" || echo "NOT in .env: the endpoint existed already, so its secret cannot be read back; paste it from the Stripe dashboard, or delete the endpoint there and run this again"); fi
unset whsec out
echo "Stripe ($mode mode): product $product, price $price, webhook endpoint $wh at https://$PORTAL_HOST/stripe/webhook; signing secret $wrote."
echo "STRIPE_PRICE_TEAM is in .env. Now: docker compose --profile public up -d portal"
