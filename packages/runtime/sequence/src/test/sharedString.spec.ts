/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { TextSegment } from "@prague/merge-tree";
import { ITree } from "@prague/protocol-definitions";
import { ISharedObjectServices } from "@prague/runtime-definitions";
import { MockDeltaConnectionFactory, MockRuntime, MockStorage } from "@prague/runtime-test-utils";
import * as assert from "assert";
import { SharedString } from "../sharedString";

describe("SharedString", () => {

    const documentId = "fakeId";
    let deltaConnectionFactory: MockDeltaConnectionFactory;
    let sharedString: SharedString;
    beforeEach(() => {
        const runtime = new MockRuntime();
        deltaConnectionFactory = new MockDeltaConnectionFactory();
        sharedString = new SharedString(runtime, documentId);
        runtime.services = {
            deltaConnection: deltaConnectionFactory.createDeltaConnection(runtime),
            objectStorage: new MockStorage(undefined),
        };
        runtime.attach();
    });

    describe(".sendNACKed", () => {

        const insertCount = 5;
        beforeEach(() => {
            sharedString.initializeLocal();
            sharedString.register();
            assert(sharedString.client.mergeTree.pendingSegments.empty());

            for (let i = 0; i < insertCount; i++) {
                sharedString.insertText(i, "hello");
                assert.equal(sharedString.client.mergeTree.pendingSegments.count(), i + 1);
            }
        });

        it("acked insertSegment", async () => {

            await deltaConnectionFactory.processAllMessages();
            assert(sharedString.client.mergeTree.pendingSegments.empty());

            sharedString.sendNACKed();
            assert(sharedString.client.mergeTree.pendingSegments.empty());
        });

        it("nacked insertSegment", async () => {
            sharedString.sendNACKed();
            // we expect a nack op per segment since our original ops split segments
            // we should expect mores nack ops then original ops.
            // only the first op didn't split a segment, all the others did
            assert.equal(sharedString.client.mergeTree.pendingSegments.count(), (insertCount * 2) - 1);
            await deltaConnectionFactory.processAllMessages();
            assert(sharedString.client.mergeTree.pendingSegments.empty());
        });

        it("acked removeRange", async () => {
            await deltaConnectionFactory.processAllMessages();
            assert(sharedString.client.mergeTree.pendingSegments.empty());

            sharedString.removeRange(0, sharedString.getLength());
            await deltaConnectionFactory.processAllMessages();
            assert(sharedString.client.mergeTree.pendingSegments.empty());

            sharedString.sendNACKed();
            assert(sharedString.client.mergeTree.pendingSegments.empty());
        });

        it("nacked removeRange", async () => {
            await deltaConnectionFactory.processAllMessages();
            assert(sharedString.client.mergeTree.pendingSegments.empty());

            sharedString.removeRange(0, sharedString.getLength());
            sharedString.sendNACKed();
            // we expect a nack op per segment since our original ops split segments
            // we should expect mores nack ops then original ops.
            // only the first op didn't split a segment, all the others did
            assert.equal(sharedString.client.mergeTree.pendingSegments.count(), (insertCount * 2) - 1);
            await deltaConnectionFactory.processAllMessages();
            assert(sharedString.client.mergeTree.pendingSegments.empty());
        });

        it("nacked insertSegment and removeRange", async () => {
            // if a segment is inserted and removed, we don't need to do anything on nack
            sharedString.removeRange(0, sharedString.getLength());
            sharedString.sendNACKed();
            assert(sharedString.client.mergeTree.pendingSegments.empty());
        });

        it("acked annotateRange", async () => {
            await deltaConnectionFactory.processAllMessages();
            assert(sharedString.client.mergeTree.pendingSegments.empty());

            sharedString.annotateRange(0, sharedString.getLength(), { foo: "bar" });
            await deltaConnectionFactory.processAllMessages();
            assert(sharedString.client.mergeTree.pendingSegments.empty());

            sharedString.sendNACKed();
            assert(sharedString.client.mergeTree.pendingSegments.empty());
        });

        it("nacked annotateRange", async () => {
            await deltaConnectionFactory.processAllMessages();
            assert(sharedString.client.mergeTree.pendingSegments.empty());

            sharedString.annotateRange(0, sharedString.getLength(), { foo: "bar" });
            sharedString.sendNACKed();
            // we expect a nack op per segment since our original ops split segments
            // we should expect mores nack ops then original ops.
            // only the first op didn't split a segment, all the others did
            assert.equal(sharedString.client.mergeTree.pendingSegments.count(), (insertCount * 2) - 1);
            await deltaConnectionFactory.processAllMessages();
            assert(sharedString.client.mergeTree.pendingSegments.empty());
        });

        it("nacked insertSegment and annotateRange", async () => {
            sharedString.annotateRange(0, sharedString.getLength(), { foo: "bar" });
            sharedString.sendNACKed();
            // we expect a nack op per segment since our original ops split segments
            // we should expect mores nack ops then original ops.
            // only the first op didn't split a segment, all the others did
            assert.equal(sharedString.client.mergeTree.pendingSegments.count(), (insertCount * 2) - 1);
            await deltaConnectionFactory.processAllMessages();
            assert(sharedString.client.mergeTree.pendingSegments.empty());
        });
    });

    describe(".snapshot", () => {

        it("Create and compare snapshot", async () => {
            const insertText = "text";
            const segmentCount = 1000;

            sharedString.initializeLocal();

            for (let i = 0; i < segmentCount; i = i + 1) {
                sharedString.client.insertSegmentLocal(0, new TextSegment(`${insertText}${i}`));
            }

            let tree = sharedString.snapshot();
            assert(tree.entries.length === 2);
            assert(tree.entries[0].path === "header");
            assert(tree.entries[1].path === "content");
            let subTree = tree.entries[1].value as ITree;
            assert(subTree.entries.length === 2);
            assert(subTree.entries[0].path === "header");
            assert(subTree.entries[1].path === "tardis");

            await CreateStringAndCompare(tree);

            for (let i = 0; i < segmentCount; i = i + 1) {
                sharedString.client.insertSegmentLocal(0, new TextSegment(`${insertText}-${i}`));
            }

            // TODO: Due to segment packing, we have only "header" and no body
            // Need to change test to include other types of segments (like marker) to exercise "body".
            tree = sharedString.snapshot();
            assert(tree.entries.length === 2);
            assert(tree.entries[0].path === "header");
            assert(tree.entries[1].path === "content");
            subTree = tree.entries[1].value as ITree;
            assert(subTree.entries.length === 2);
            assert(subTree.entries[0].path === "header");
            assert(subTree.entries[1].path === "tardis");

            await CreateStringAndCompare(tree);
        });

        async function CreateStringAndCompare(tree: ITree): Promise<void> {

            const runtime = new MockRuntime();
            const services: ISharedObjectServices = {
                deltaConnection: deltaConnectionFactory.createDeltaConnection(runtime),
                objectStorage: new MockStorage(tree),
            };

            const sharedString2 = new SharedString(runtime, documentId);
            await sharedString2.load(0, null/*headerOrigin*/, services);
            await sharedString2.loaded;

            assert(sharedString.getText() === sharedString2.getText());
        }
    });
});
