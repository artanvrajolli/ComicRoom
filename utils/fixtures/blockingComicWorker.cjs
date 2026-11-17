process.on('message', ({ id, job }) => {
    if (job.kind === 'crash') process.exit(9);
    if (job.kind === 'error') { process.send({ id, type: 'error', error: 'Corrupt archive fixture' }); return; }
    process.send({ id, type: 'progress', progress: 30 });
    // Model a synchronous decompressor or slow synchronous disk write.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, job.blockMs || 800);
    process.send({ id, type: 'progress', progress: 60 });
    process.send({ id, type: 'result', result: { pid: process.pid } });
});
process.on('disconnect', () => process.exit(0));
