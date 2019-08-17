/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { ReplayArgs, ReplayTool } from "@prague/replay-tool";
import * as fs from "fs";
import * as threads from "worker_threads";

const fileLocation: string = "content";

export enum Mode {
    Write,   // write out files
    Compare, // compare to files stored on disk
    Stress,  // Do stress testing without writing or comparing out files.
}

export interface IWorkerArgs {
    folder: string;
    mode: Mode;
    snapFreq: number;
}

// tslint:disable:non-literal-fs-path

export async function processOneFile(args: IWorkerArgs) {
    const replayArgs = new ReplayArgs();

    replayArgs.verbose = false;
    replayArgs.inDirName = args.folder;
    replayArgs.outDirName = args.folder;
    replayArgs.snapFreq = args.snapFreq;

    replayArgs.write = args.mode === Mode.Write;
    replayArgs.compare = args.mode === Mode.Compare;
    // Make it easier to see problems in stress tests
    replayArgs.expandFiles = args.mode === Mode.Stress;

    const res = await new ReplayTool(replayArgs).Go();
    if (!res) {
        throw new Error(`Error processing ${args.folder}`);
    }
}

export async function processContent(mode: Mode, concurrently = true) {
    // tslint:disable-next-line:prefer-array-literal
    const promises: Array<Promise<unknown>> = [];

    threads.Worker.EventEmitter.defaultMaxListeners = 20;

    for (const node of fs.readdirSync(fileLocation, { withFileTypes : true })) {
        if (!node.isDirectory()) {
            continue;
        }
        const folder = `${fileLocation}/${node.name}`;
        const messages = `${folder}/messages.json`;
        if (!fs.existsSync(messages)) {
            console.error(`Can't locate ${messages}`);
            continue;
        }

        // snapFreq is the most interesting options to tweak
        // On one hand we want to generate snapshots often, ideally every 50 ops
        // This allows us to exercise more cases and increases chances of finding bugs.
        // At the same time that generates more files in repository, and adds to the size of it
        // Thus using two passes:
        // 1) Stress test - testing eventual consistency only
        // 2) Testing backward compat - only testing snapshots at every 1000 ops
        const snapFreq = mode === Mode.Stress ? 50 : 1000;
        const workerData: IWorkerArgs = {
            folder,
            mode,
            snapFreq,
        };

        if (!concurrently) {
            console.log(folder);
            await processOneFile(workerData);
            continue;
        }

        const work = new Promise((resolve, reject) => {
            const worker = new threads.Worker("./dist/replayWorker.js", { workerData });

            worker.on("message", (error: string) => {
                if (mode === Mode.Compare) {
                    // tslint:disable-next-line: max-line-length
                    const extra = "If you changed snapshot representation and validated new format is backward compatible, you can run `npm run test:generate` to regenerate baseline snapshots";
                    reject(new Error(`${error}\n${extra}`));
                } else {
                    reject(new Error(error));
                }
            });

            worker.on("error", (error) => {
                reject(error);
            });

            worker.on("exit", (code) => {
                if (code !== 0) {
                    reject(new Error(`Worker stopped with exit code ${code}`));
                }
                resolve();
            });
        });

        promises.push(work);
    }

    return Promise.all(promises);
}