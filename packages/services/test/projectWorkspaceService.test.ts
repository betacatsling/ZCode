import assert from "node:assert/strict";
import test from "node:test";
import type { IChannelServer } from "@zcode/rpc";
import {
  getProjectWorkspaceWriteExclusions,
  IProjectCatalogService,
  IWorktreeService,
} from "../src/projectWorkspaceServices.js";
import { ServiceCollection } from "../src/collection.js";

const catalog = {} as IProjectCatalogService;
const worktree = {} as IWorktreeService;

test("Project Catalog and Worktree descriptors register through the existing collection", () => {
  const collection = new ServiceCollection()
    .register(IProjectCatalogService, catalog)
    .register(IWorktreeService, worktree);
  const registered: string[] = [];
  const server: IChannelServer = {
    registerChannel(name) {
      registered.push(name);
    },
  };
  collection.exposeOnChannelServer(server, new Map(), new Set());
  assert.deepEqual(registered, [IProjectCatalogService.channelName, IWorktreeService.channelName]);
});

test("generic replayable channel scope excludes both profile and target writes", () => {
  const collection = new ServiceCollection()
    .register(IProjectCatalogService, catalog)
    .register(IWorktreeService, worktree);
  const registered: string[] = [];
  const server: IChannelServer = {
    registerChannel(name) {
      registered.push(name);
    },
  };
  collection.exposeOnChannelServer(
    server,
    new Map(),
    getProjectWorkspaceWriteExclusions("web-remote-replayable"),
  );
  assert.deepEqual(registered, []);
});

test("trusted desktop scope retains both profile and target channels", () => {
  const collection = new ServiceCollection()
    .register(IProjectCatalogService, catalog)
    .register(IWorktreeService, worktree);
  const registered: string[] = [];
  const server: IChannelServer = {
    registerChannel(name) {
      registered.push(name);
    },
  };
  collection.exposeOnChannelServer(
    server,
    new Map(),
    getProjectWorkspaceWriteExclusions("desktop-continuous"),
  );
  assert.deepEqual(registered, [IProjectCatalogService.channelName, IWorktreeService.channelName]);
});

test("an older Host can omit the optional Worktree channel without a guessed fallback", () => {
  const collection = new ServiceCollection();
  assert.equal(collection.getOptional(IWorktreeService), undefined);
  assert.equal(collection.getOptional(IProjectCatalogService), undefined);
});
