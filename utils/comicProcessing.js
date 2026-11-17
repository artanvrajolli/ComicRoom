const path = require('path');
const { fork } = require('child_process');

class ComicProcessing {
    constructor(options = {}) {
        this.workerPath = options.workerPath || path.join(__dirname, 'comicProcessingWorker.js');
        this.cwd = options.cwd || process.cwd();
        this.env = options.env || process.env;
        this.worker = null;
        this.active = null;
        this.nextId = 1;
        this.idleTimer = null;
    }

    getWorker() {
        if (this.worker?.connected) return this.worker;
        const child = fork(this.workerPath, [], {
            cwd: this.cwd, env: this.env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
            // Never inherit the web process's debugger port in a child.
            execArgv: process.execArgv.filter(arg => !arg.startsWith('--inspect'))
        });
        this.worker = child;
        child.on('message', message => this.onMessage(child, message));
        child.on('error', error => this.fail(child, error));
        child.on('exit', (code, signal) => {
            this.fail(child, new Error(`Comic processing worker exited (${signal || code}). Please retry the upload.`));
        });
        return child;
    }

    fail(child, error) {
        if (this.worker === child) this.worker = null;
        if (this.active?.child === child) {
            const active = this.active;
            this.active = null;
            active.reject(error);
        }
    }

    onMessage(child, message) {
        const active = this.active;
        if (!active || active.child !== child || message?.id !== active.id) return;
        if (message.type === 'progress') {
            active.updates = active.updates.then(() => active.onProgress(message.progress));
            active.updates.catch(error => { this.fail(child, error); child.kill(); });
        } else if (message.type === 'result' || message.type === 'error') {
            active.updates.then(() => {
                if (this.active !== active) return;
                this.active = null;
                if (message.type === 'error') active.reject(new Error(message.error || 'Comic processing failed.'));
                else active.resolve(message.result);
                this.idleTimer = setTimeout(() => {
                    if (!this.active && this.worker === child) { this.worker = null; child.disconnect(); }
                }, 5 * 60 * 1000);
                this.idleTimer.unref();
            }).catch(error => { this.fail(child, error); child.kill(); });
        }
    }

    run(job, onProgress = async () => {}) {
        if (this.active) return Promise.reject(new Error('Comic processing is already running.'));
        clearTimeout(this.idleTimer);
        return new Promise((resolve, reject) => {
            const child = this.getWorker();
            const id = this.nextId++;
            this.active = { id, child, resolve, reject, onProgress, updates: Promise.resolve() };
            child.send({ id, type: 'prepare', job }, error => {
                if (error) { this.fail(child, error); child.kill(); }
            });
        });
    }

    stop() {
        clearTimeout(this.idleTimer);
        const child = this.worker;
        if (!child) return;
        this.fail(child, new Error('Comic processing stopped.'));
        child.kill();
    }
}

module.exports = new ComicProcessing();
module.exports.ComicProcessing = ComicProcessing;
