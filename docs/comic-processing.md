# Comic processing and HTTP responsiveness

`utils/jobProcessor.js` owns the upload queue, database records, progress,
privacy refresh and completion notifications. It sends file preparation to
`utils/comicProcessingWorker.js` through the `comicProcessing.js` child-process
client. Only one upload is processed at a time.

Archive reads and decompression, PDF rendering, URL image imports, nested archive
splitting, folder scans and AI image preparation all run in that child. These
operations use libraries with synchronous filesystem and CPU work; wrapping
them in a Promise does not make them safe to run on Express's event loop.
The child returns prepared comic metadata, so the parent does not scan the
output folders again while committing the upload.

Progress updates are saved in order before the child result is accepted. A
child crash fails its upload, preserves the source file, and allows a fresh
child to handle the next upload. Ordinary archive errors can reuse the child.
The child disconnects after five idle minutes and exits if the parent exits.
Application shutdown stops the worker through the existing processor stop hook.

This isolates processing from HTTP requests, but both processes still share
disk bandwidth. An uncached file may still take longer to load on a busy disk.

Validation:

- `node --test utils/comicProcessing.test.js`: HTTP responsiveness during a
  deliberately blocking child task; ordered progress; errors, crashes and
  recovery; actual single-comic and nested CBZ extraction.
- `node --test utils/jobProcessor.test.js`: multi-comic results, privacy before
  completion, monotonic progress, asynchronous cleanup, and queue release after
  worker failure. Synchronous filesystem calls in the HTTP coordinator fail
  the test.
