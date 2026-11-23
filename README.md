# BookBeam Niche Finder → CSV

A [Tampermonkey](https://www.tampermonkey.net/) userscript that exports **BookBeam Niche Finder** results to a CSV file, with the same columns you see in the results table, in search order.

BookBeam's Niche Finder shows 15 books per page and has no export button. This script adds one: pick a page range, click **Start**, and get a CSV.

> **Unofficial.** This project is not affiliated with, endorsed by or supported by BookBeam. It only works inside your own logged-in BookBeam session. Check BookBeam's terms of service before using it.

## Features

- **Same columns as the table:** Title, Author, Pages, Age, Market, Amazon link, Rating, Reviews, BSR, Sales (Mo), Royalty (Mo), Price, Publisher.
- **Search order:** rows are numbered by their real position in the search (`#`). Without a column sort, rows are ordered by ascending BSR, as BookBeam does. Duplicates (the same ASIN on two pages) are removed.
- **Page range:** export from page *X* to page *Y* (1 = first page, both inclusive).
- **Threads:** 1–5 parallel requests.
- **Rate-limit aware:** on an HTTP 429 the script drops to one thread, waits with growing back-off (5 s, 10 s, 20 s, 40 s, or the server's `Retry-After`) and lengthens the pause between pages for the rest of the run. If it still fails, it downloads the rows collected so far.
- **Doesn't use your searches:** it repeats the same request as the **>** (next page) button, which does not decrease the "Searches Left" counter (checked on 2026-11-23; BookBeam may change this).
- **Magnetic bubble UI:** a green bubble in the bottom-right corner drifts toward your cursor and opens the export panel on hover.

## Install

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
2. **[Click here to install the script](https://raw.githubusercontent.com/angelo18181818/bookbeam-niche-finder-csv-export/main/bookbeam-niche-finder-csv.user.js)**. Tampermonkey opens an install page: click **Install**.
3. Reload `app.bookbeam.io`.

Tampermonkey checks this repository for updates automatically.

Manual alternative: in Tampermonkey choose **Create a new script**, delete the template, paste the contents of [`bookbeam-niche-finder-csv.user.js`](bookbeam-niche-finder-csv.user.js) and save.

## Usage

1. Open **Research → Niche Finder**, set your filters and click **Find Books** once. This uses one search, as usual, and lets the script read your filters.
2. Hover the green bubble in the bottom-right corner.
3. Set **From page**, **To page** and **Threads**, then click **Start**.
4. The CSV downloads as `bookbeam_niche_<market>_<date>_p<from>-<to>.csv`.

The panel shows how many pages and books the range covers, and the last available page.

## CSV columns

| Column | Source field | Notes |
|---|---|---|
| `#` | position in the search | 1 = first result |
| Title | `title` | |
| Author | `author` | |
| Pages | `numberOfPages` | |
| Age | `publicationDate` | formatted like the table: `20d`, `5m`, `1y 4m` |
| Market | `marketplace` | e.g. `US` |
| Link | `asin` | `https://www.amazon.com/dp/<ASIN>` |
| Rating | `rating` | |
| Reviews | `reviewsQuantity` | |
| BSR | `bestsellerRank` | |
| Sales (Mo) | `salesPerMonth` | BookBeam estimate |
| Royalty (Mo) | `income` | BookBeam estimate |
| Price | `price` | |
| Publisher | `publisher` | |

Sales and royalty are **BookBeam's model estimates**, not Amazon data.

## Settings

Edit the `CONFIG` object at the top of the script:

| Setting | Default | Meaning |
|---|---|---|
| `DEFAULT_FROM` / `DEFAULT_TO` | `1` / `5` | initial page range |
| `PARALLEL` | `2` | initial threads (1–`MAX_PARALLEL`) |
| `MAX_PARALLEL` | `5` | highest value allowed in the panel |
| `DELAY_MS` | `400` | pause between pages |
| `MAX_DELAY_MS` | `8000` | longest pause after repeated 429s |
| `RETRIES` | `4` | retries after a 429 |
| `BACKOFF_MS` | `5000` | first wait after a 429 |
| `EUROPEAN_CSV` | `false` | `true` = `;` separator and decimal comma, for Excel in European locales |

## Notes and limits

- **Speed.** Each book in the response carries its full BSR history, so a 15-book page is about 6 MB and takes about 1.5 s on the server. Larger page sizes are slower per book (tested: 50 books took 17 s), so the script keeps BookBeam's 15 per page.
- **Rate limit.** Three or more parallel requests can trigger HTTP 429 right away. Two usually work; the script backs off on its own.
- **Privacy.** The script reuses the headers of the request BookBeam itself sends. Your session token stays in the page: it is never stored, logged or sent anywhere other than BookBeam.
- **Fragility.** It depends on BookBeam's internal API (`/book-tracker-service/api/v1/niche-finder`), which can change without notice.

## License

[MIT](LICENSE)
