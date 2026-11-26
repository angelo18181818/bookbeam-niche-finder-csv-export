# BookBeam Niche Finder → CSV

A [Tampermonkey](https://www.tampermonkey.net/) userscript that exports **BookBeam Niche Finder** results to a CSV file, with the same columns you see in the results table, in search order.

BookBeam's Niche Finder shows 15 books per page and has no export button. This script adds one: tick **Max** (or pick a page range), click **Start export**, and get a CSV.

> **Unofficial.** This project is not affiliated with, endorsed by or supported by BookBeam. It only works inside your own logged-in BookBeam session. Check BookBeam's terms of service before using it.

## Features

- **Same columns as the table:** Title, Author, Pages, Age, Market, Amazon link, Rating, Reviews, BSR, Sales (Mo), Royalty (Mo), Price, Publisher.
- **Search order:** rows are numbered by their real position in the search (`#`). Without a column sort, rows are ordered by ascending BSR, as BookBeam does.
- **Duplicates removed:** BookBeam itself repeats some books on different pages. They are removed by ASIN when the file is built, after all pages have been downloaded, and the panel shows how many.
- **Max:** on by default, exports from page 1 to the last page. Untick it to choose a range; your previous range comes back.
- **Real last page:** BookBeam's result count is an estimate and is usually too high. Past the real last page BookBeam answers HTTP 404: the export stops there after two empty pages in a row and reports *Finished*.
- **Nothing is lost:** a page that fails goes back to the queue. If it still fails it is listed as missing (in ranges, e.g. `206–300, 305`) and **Recover missing pages** downloads only those, then saves the whole list again. Stopping by hand works the same way.
- **Speed you control while it runs:** parallel requests (default 1) and delay between requests (default 0.8 s, with arrows). Changes apply to the export in progress.
- **Antithrottled:** when BookBeam slows down or fails (HTTP 429, 503, timeouts), the delay grows by 0.1 s, the script drops to 1 request and pauses (5 s, +2 s for each further error in a row, or the server's `Retry-After`). Parallel requests come back one at a time when the server is stable.
- **Progress and time left:** progress bar, page being downloaded, books, duplicates, retries, estimated time left, elapsed time and pages per minute.
- **Log and report in the panel:** every event is logged with its time; at the end a report shows pages, books, duplicates, errors, time and file name. No browser pop-ups.
- **Doesn't use your searches:** it repeats the same request as the **>** (next page) button, which does not decrease the "Searches Left" counter (checked on 2026-11-23; BookBeam may change this).
- **Bubble only where it's needed:** it appears only on the Niche Finder page (`#/niche-finder`). An export keeps running if you move to another page.
- **Living bubble:** a soft body drawn on a canvas (Verlet integration with XPBD-style length and area constraints), a damped-spring magnet with distance falloff, a metaball droplet that joins your cursor, Fresnel rim, thin-film iridescence and a progress ring. It runs at 60 fps only while it moves, about 20 fps when idle, and not at all while the tab is hidden. With "reduce motion" on in your system, or `MOTION: false`, it stays still.

## Install

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
2. **[Click here to install the script](https://raw.githubusercontent.com/angelo18181818/bookbeam-niche-finder-csv-export/main/bookbeam-niche-finder-csv.user.js)**. Tampermonkey opens an install page: click **Install**.
3. Reload `app.bookbeam.io`.

Tampermonkey checks this repository for updates automatically.

Manual alternative: in Tampermonkey choose **Create a new script**, delete the template, paste the contents of [`bookbeam-niche-finder-csv.user.js`](bookbeam-niche-finder-csv.user.js) and save.

## Usage

1. Open **Research → Niche Finder**, set your filters and click **Find Books** once. This uses one search, as usual, and lets the script read your filters.
2. Hover the green bubble in the bottom-right corner (click it to keep the panel open).
3. Keep **Max** ticked for the whole list, or untick it and set **From page** / **To page**.
4. Click **Start export**. The CSV downloads at the end as `bookbeam_niche_<market>_<date>_p<from>-<to>.csv` (`_PARTIAL` if pages are missing).
5. If pages are missing, click **Recover missing pages**. Do not reload the page before that: the downloaded pages live in the tab.

## CSV columns

| Column | Source field | Notes |
|---|---|---|
| `#` | position in the search | 1 = first result |
| Title | `title` | |
| Author | `author` | |
| Pages | `numberOfPages` | |
| Age | `publicationDate` | formatted like the table: `20d`, `5m`, `1y 4m` |
| Market | `marketplace` | e.g. `US` |
| Link | `asin` | Amazon store of the market, e.g. `https://www.amazon.com/dp/<ASIN>` |
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
| `DEFAULT_FROM` / `DEFAULT_TO` | `1` / `5` | range restored when **Max** is unticked |
| `MAX_DEFAULT` | `true` | **Max** ticked when the panel opens |
| `PARALLEL` | `1` | parallel requests (1–`MAX_PARALLEL`) |
| `MAX_PARALLEL` | `5` | highest value allowed in the panel |
| `DELAY_S` | `0.8` | delay between requests, in seconds, for each parallel request |
| `DELAY_STEP_S` | `0.1` | how much **Antithrottled** adds at each server warning |
| `ANTITHROTTLED` | `true` | **Antithrottled** ticked when the panel opens |
| `BACKOFF_MS` / `BACKOFF_STEP_MS` | `5000` / `2000` | pause after an error, and how much it grows for each further error in a row |
| `TIMEOUT_MS` | `45000` | a page with no answer after this long is retried |
| `PAGE_TRIES` | `5` | tries per page before the final pass |
| `MAX_FAILS` | `30` | errors in a row (no page at all) before stopping |
| `EUROPEAN_CSV` | `false` | `true` = `;` separator and decimal comma, for Excel in European locales |
| `MOTION` | `true` | bubble physics; `false` = still bubble |

## Notes and limits

- **Rate limit.** BookBeam answers HTTP 429 with `Retry-After: 10` when requests come too fast (observed on 2026-11-25: never more than 6 accepted in 10 seconds). With the default 1 request and 0.8 s delay it happens now and then; **Antithrottled** slows down on its own. A full Niche Finder list of about 300 pages takes roughly 10 minutes.
- **Missing books.** BookBeam's own pagination repeats some books and skips others: the same search sorted in two different ways returned different books (observed on 2026-11-26). Treat competitor counts from one export as a minimum.
- **Memory.** Only the CSV fields are kept: the sales and rank history in BookBeam's answer is dropped at once.
- **Reloading the page** loses the pages kept in the tab, including a pending recovery.
- **Privacy.** The script reuses the headers of the request BookBeam itself sends. Your session token stays in the page: it is never stored, logged or sent anywhere other than BookBeam.
- **Fragility.** It depends on BookBeam's internal API (`/book-tracker-service/api/v1/niche-finder`), which can change without notice.

## License

[MIT](LICENSE)
