# Fair Draw

Pick a raffle winner in a way anyone can check afterwards — including people who
weren't there and have no reason to trust you.

No account, no app, no payment, and nobody involved needs to know what a
blockchain is.

## How it works

1. You lock in the list of names. A fingerprint of that list is written onto a
   public chain, timestamped, so it cannot be backdated.
2. A moment a few minutes in the future is chosen. When it arrives, the blocks
   produced at that moment supply a number nobody could have known in advance.
3. The winners follow from that number and the list, by a calculation anyone can
   repeat.

Everyone gets a link. Opening it re-runs every check from scratch.

## What is verified

Four things, all of which must pass:

- the names match the fingerprint published beforehand
- the winners follow from the deciding number
- that number really does come from that moment on the chain
- the fingerprint was recorded **before** that moment

The last one is the important one. Without it, an organiser could wait to see the
number, work out which arrangement of names gave a result they liked, and claim
afterwards that they had committed to it all along. The arithmetic alone cannot
tell those two cases apart.

## Security

**The wallet key is never in this repository.** It lives only in an environment
variable. Publishing this code is safe; publishing a key never is.

The anchoring endpoint spends a small amount of money and deliberately has no
login, since requiring one would defeat the purpose. It is defended by limits
rather than by secrecy:

| control | effect |
|---|---|
| small float | worst case is measured in cents, not dollars |
| `ANCHOR_FLOOR_KAS` | the wallet refuses to spend below a floor |
| per-caller throttle | one request every few seconds |
| per-instance hourly cap | bounds a sustained flood |
| `ALLOWED_ORIGIN` | only your site may call it from a browser |

Open-sourcing does not create that exposure. An unauthenticated endpoint that
spends money is exposed whether or not the code is public — being public just
means the limits get reviewed by more people than you.

**Keep the float small.** Ten KAS is roughly five thousand draws and about thirty
cents. Top it up rather than filling it.

## Deploying

```
fairdraw/
  index.html
  netlify.toml
  netlify/
    functions/
      anchor.mjs
      kaspa/            <- the SDK, not committed; see below
```

The SDK is a 12MB download rather than source, so it is gitignored. Get
`kaspa-wasm32-sdk-v2.0.1.zip` from github.com/kaspanet/rusty-kaspa/releases,
unzip it, and copy `kaspa-wasm32-sdk/nodejs/kaspa` to
`netlify/functions/kaspa`.

`netlify.toml` sets `node_bundler = "none"` on purpose. Bundling moves the
`.wasm` file and breaks the path it is loaded from.

Environment variables in Netlify:

| name | required | notes |
|---|---|---|
| `KASPA_ANCHOR_KEY` | yes | hex private key of a dedicated throwaway wallet |
| `ALLOWED_ORIGIN` | recommended | your site's URL, so other sites cannot call it |
| `ANCHOR_FLOOR_KAS` | optional | defaults to 2 |
| `KASPA_NODE_URL` | optional | your own node's borsh port, if you run one |

## Running it locally

```
node anchor-server.mjs     # the anchoring service
npx serve                  # the page
```

Open the **localhost** address. The page talks to the local service on localhost
and to the Netlify function anywhere else.

Opening the HTML file directly will not work: browsers block file-opened pages
from making web requests.

## Honest limitations

The deciding number comes from about forty blocks, and the draw uses the lowest.
Somebody running one of those computers could discard their block and try again,
but it changes the result only about one time in forty, and each attempt costs
them a block reward. Fine for a fete, a giveaway or a prize draw. Not for
anything where the prize is worth more than the electricity.

Kaspa discards its own history after about thirty hours. The public API used for
verification keeps it in a database, so draws remain checkable well beyond that —
but verification does depend on that API existing.
