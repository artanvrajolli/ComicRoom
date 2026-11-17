# URL imports

The upload page offers **Import from URL**. Paste a public chapter/reader URL,
review and select its images, then import. The result uses the existing upload
queue, status page, metadata detection and privacy setting.

**Find images using** offers Scrape (`/v2/scrape`, the default) and Agent
(`/v2/agent`). Agent asks the selected Firecrawl server's AI to identify the
original chapter images. It polls the Agent job for up to three minutes and
rejects failed or incomplete results, thumbnails, invalid URLs and private
hosts. Timed-out jobs receive a cancellation request. Both choices use the same image selection,
download, privacy and upload queue after discovery. Switching the choice clears
the previous preview so **Find images** must run again.

Agent uses the primary server only; it does not silently switch to the hosted
Agent service. Its endpoint is derived from `FIRECRAWL_API_URL` by replacing
`/scrape` with `/agent`, or can be set explicitly with `FIRECRAWL_AGENT_URL`.
Credentials follow the same custom/hosted separation as Scrape. The Agent
request is constrained to the chapter URL, requests structured JSON and sends
`maxCredits: 5` (enforcement depends on the configured Agent implementation).

Firecrawl v2 finds images on JavaScript-rendered pages. Set `FIRECRAWL_API_URL`
in the service environment for a custom server. The default is the official
hosted Firecrawl scrape endpoint.
`FIRECRAWL_FALLBACK_URL` defaults to `https://api.firecrawl.dev/v2/scrape`; set it
to an empty string to disable the hosted fallback. Both settings take the full
scrape endpoint URL. `FIRECRAWL_API_KEY` is only sent to the hosted API;
`FIRECRAWL_CUSTOM_API_KEY` is only sent to the custom endpoint. Neither key is
sent to the browser. The hosted anonymous trial works without a key; regular
use may require a key with credits.

One import handles one web page, up to 300 selected images, 25 MB per image and
500 MB total. It supports JPEG, PNG, GIF, WebP and AVIF, validates the downloaded
file signatures, blocks private network addresses and checks redirects. Downloads
are staged in the non-public temporary directory and partial downloads are
removed after failure. Image URLs are downloaded in the reviewed order.
When direct requests return 401, 403, 429 or 503, the importer fetches batches
of four images inside the reader's Firecrawl browser session. This requires
Fire Engine with browser actions support. The screenshot format enables real
media loading; screenshot output is discarded, and the original image response
bytes are saved. Image signatures and dimensions are checked to reject the
synthetic 1×1 placeholder images that a media-blocking browser can return.

The optional CSS selector narrows discovery to a reader container or image
elements. Serialized reader JSON can supply the full image list and page count
when it matches the page's discovered images, including pages not yet
lazy-loaded. Other readers may need their own
adapter or a selector. This does not follow next-chapter links, use login
cookies, or guarantee downloads from protected image hosts.

Image discovery follows linked original-image URLs instead of treating gallery
thumbnails as comic pages. It also checks explicit original/lazy-load attributes
and chooses the largest responsive `srcset` variant. Signed query strings are
preserved; CDN paths are never guessed or rewritten. Known thumbnail-only paths
and small resize URLs are excluded. Old thumbnail selections are rejected at
submission and again by the import worker; run **Find images** again to replace
an existing selection. Discovery cannot identify every custom thumbnail scheme.

Run `node --test utils/urlImport.test.js` for discovery, ordering, network
validation, redirect protection, download staging and failure cleanup tests.
