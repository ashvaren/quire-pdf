# Quire PDF

An offline PDF editor that runs entirely in the browser. No document is uploaded anywhere. The original file is never modified, and every save is reopened and checked: the text is compared word for word with the source pages, every redaction is proved empty at character level, text edits, form fields and Bates numbers are confirmed, and password protection is tested.

## Hosting on GitHub Pages

1. Create a public repository (for example `quire-pdf`) and upload the contents of this folder to its root, keeping the `lib` folder and its subfolders.
2. In the repository settings, under Pages, deploy from the `main` branch, root folder.
3. Open `https://<your-user>.github.io/quire-pdf/` in Chrome or Edge and leave it open for a minute while it stores itself for offline use.
4. Install it: Edge, menu, Apps, Install this site as an app; or Chrome, menu, Cast, save and share, Install page as app.

Once installed it runs with no internet connection. Installed, it can also be chosen under Open with for PDF files.

## Updating

Upload the changed files over the old ones and change `VERSION` in `sw.js` (for example `quire-v4-2` to `quire-v4-3`). Installed copies pick up the new version the next time they are opened while online, and use it from the launch after that.

## Features

- View, search (including phrases split across text runs), zoom; bookmarks panel.
- Combine PDFs; reorder, rotate, delete and extract pages; insert blank pages and images as pages; split into several files.
- Highlight, underline and strike through text; text boxes, drawing, boxes, white-out; stamps; real PDF comments.
- Signatures: drawn, typed or from an image.
- Edit existing text line by line.
- True redaction by area, by search term or by pattern (email addresses, phone numbers, postcodes, sort codes and account numbers, National Insurance numbers, money amounts), on text and on scanned pages.
- Text recognition (English) for scanned pages, producing searchable PDFs.
- Export to Word: real paragraphs with fonts, indents, spacing, alignment, tabs, list markers and images; page breaks kept.
- Build forms: text, paragraph, checkbox, dropdown and signature fields; automatic detection of dotted and underlined lines.
- Fill and flatten forms.
- Headers and footers with codes ({page}, {pages}, {date}, {file}, {bates}); Bates numbering.
- Batch processing: text recognition, redaction, hidden-data removal, compression, watermark, headers and footers, Bates numbers continuing across files, passwords; results in one zip with a report.
- Open password-protected PDFs; protect copies with AES-256 and optional restrictions; remove hidden data.
- Compare two versions word by word.
- Watermark, page numbers, recompression of photos and scans.

## Libraries

- PDF.js 4.10.38 (Apache 2.0)
- pdf-lib 1.17.1 (MIT)
- MuPDF.js 1.26.4 (AGPL 3.0; fine for personal use, but anyone distributing a modified version publicly must publish its source)
- Tesseract.js 6.0.1 and tesseract.js-core 6.0.0 (Apache 2.0), with the English "best_int" language data (Apache 2.0), stored as `lib/tess/eng-traineddata.wasm` so that any static host will serve it
- fflate 0.8.2 (MIT)

Control characters inside string literals in two library files are written as escape sequences; behaviour is unchanged.
