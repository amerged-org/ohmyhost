import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { InvalidCommandError } from "../src/command.js";
import { LinkedProjectAmbiguousError, parseWithLinkedProject } from "../src/composition.js";
import {
  chooseLinkedProject,
  linkedOrganization,
  OwnerOnlyProjectLinkStore,
  readProjectLinks,
  removeLegacyProjectLink,
} from "../src/project-link-store.js";

const ORIGIN = "https://control.example.test";
const AMERGED = "01M0WRKSPACEAAAAAAAAAAAAAA";
const SEBMER = "01M0WRKSPACEBBBBBBBBBBBBBB";
const AMERGED_PROJECT = "01K2F3G4H5J6K7M8N9P0QRSTVW";
const SEBMER_PROJECT = "01K2F3G4H5J6K7M8N9P0QRSTVX";
const link = (organizationId: string, projectId: string) =>
  ({
    version: 2,
    api_origin: ORIGIN,
    organization_id: organizationId,
    project_id: projectId,
    installation_id: "42",
    repository_full_name: "owner/repo",
  }) as const;

describe("linked project defaults", () => {
  it("keeps one link per organization in the same checkout and reads only this API's links", async () => {
    const root = await mkdtemp(join(tmpdir(), "ohmyhost-link-"));
    const directory = join(root, ".ohmyhost");
    await expect(readProjectLinks(directory, ORIGIN)).resolves.toEqual({ links: [], legacy: null });
    const store = new OwnerOnlyProjectLinkStore(directory);
    await store.save(link(AMERGED, AMERGED_PROJECT));
    await store.save(link(SEBMER, SEBMER_PROJECT));
    // A second account links the same working copy without overwriting the first one's link.
    const both = await readProjectLinks(directory, ORIGIN);
    expect(both).toEqual({
      links: [link(AMERGED, AMERGED_PROJECT), link(SEBMER, SEBMER_PROJECT)],
      legacy: null,
    });
    expect(chooseLinkedProject(both, SEBMER)).toEqual({
      outcome: "linked",
      projectId: SEBMER_PROJECT,
      organizationId: SEBMER,
    });
    // Without a chosen login nothing guesses between two organizations' projects.
    expect(chooseLinkedProject(both, undefined)).toEqual({
      outcome: "ambiguous",
      organizationIds: [AMERGED, SEBMER],
    });
    expect(chooseLinkedProject(both, "01M0WRKSPACECCCCCCCCCCCCCC")).toEqual({ outcome: "none" });
    expect(linkedOrganization(both, SEBMER_PROJECT)).toBe(SEBMER);
    expect(linkedOrganization(both, "01K2F3G4H5J6K7M8N9P0QRSTVZ")).toBeUndefined();
    await expect(readProjectLinks(directory, "https://other.example.test")).resolves.toEqual({
      links: [],
      legacy: null,
    });
    await writeFile(join(directory, "links", `${AMERGED}.json`), "{not json");
    await writeFile(
      join(directory, "links", `${SEBMER}.json`),
      JSON.stringify({ ...link(AMERGED, SEBMER_PROJECT) }),
    );
    // A malformed file or one whose name and content disagree is not a link.
    await expect(readProjectLinks(directory, ORIGIN)).resolves.toEqual({ links: [], legacy: null });
  });

  it("offers a link written before links named their organization only for verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "ohmyhost-link-"));
    const directory = join(root, ".ohmyhost");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "link.json"),
      JSON.stringify({
        version: 1,
        api_origin: ORIGIN,
        project_id: AMERGED_PROJECT,
        installation_id: "42",
        repository_full_name: "owner/repo",
      }),
    );
    const legacy = await readProjectLinks(directory, ORIGIN);
    expect(legacy.legacy).toEqual({
      project_id: AMERGED_PROJECT,
      installation_id: "42",
      repository_full_name: "owner/repo",
    });
    // Its organization is unknown until the API confirms which account can see the project.
    expect(chooseLinkedProject(legacy, undefined)).toEqual({
      outcome: "linked",
      projectId: AMERGED_PROJECT,
      organizationId: null,
    });
    expect(chooseLinkedProject(legacy, SEBMER)).toEqual({
      outcome: "linked",
      projectId: AMERGED_PROJECT,
      organizationId: null,
    });
    await new OwnerOnlyProjectLinkStore(directory).save(link(SEBMER, SEBMER_PROJECT));
    expect(chooseLinkedProject(await readProjectLinks(directory, ORIGIN), undefined)).toEqual({
      outcome: "ambiguous",
      organizationIds: [SEBMER],
    });
    await removeLegacyProjectLink(directory);
    expect((await readProjectLinks(directory, ORIGIN)).legacy).toBeNull();
  });

  it("fills --project from the link only when a command needs it and it is missing", async () => {
    const linked = async () =>
      ({ outcome: "linked", projectId: AMERGED_PROJECT, organizationId: AMERGED }) as const;
    await expect(parseWithLinkedProject(["project", "status"], linked)).resolves.toMatchObject({
      command: { kind: "project-status", projectId: AMERGED_PROJECT },
      linked: { projectId: AMERGED_PROJECT, organizationId: AMERGED },
    });
    await expect(
      parseWithLinkedProject(["project", "status", "--project", SEBMER_PROJECT], linked),
    ).resolves.toMatchObject({ command: { projectId: SEBMER_PROJECT }, linked: null });
    await expect(parseWithLinkedProject(["whoami"], linked)).resolves.toMatchObject({
      linked: null,
    });
    await expect(
      parseWithLinkedProject(["project", "status"], async () => ({ outcome: "none" })),
    ).rejects.toBeInstanceOf(InvalidCommandError);
    await expect(
      parseWithLinkedProject(["project", "status"], async () => ({
        outcome: "ambiguous",
        organizationIds: [AMERGED, SEBMER],
      })),
    ).rejects.toEqual(new LinkedProjectAmbiguousError([AMERGED, SEBMER]));
  });

  it("keeps the local link out of Git once", async () => {
    const root = await mkdtemp(join(tmpdir(), "ohmyhost-link-"));
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".gitignore"), "node_modules\n");
    const store = new OwnerOnlyProjectLinkStore(join(root, ".ohmyhost"), root);
    await store.save(link(AMERGED, AMERGED_PROJECT));
    await store.save(link(SEBMER, SEBMER_PROJECT));
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe("node_modules\n/.ohmyhost/\n");
    const fresh = await mkdtemp(join(tmpdir(), "ohmyhost-link-"));
    await mkdir(join(fresh, ".git"));
    await new OwnerOnlyProjectLinkStore(join(fresh, ".ohmyhost"), fresh).save(
      link(AMERGED, AMERGED_PROJECT),
    );
    expect(await readFile(join(fresh, ".gitignore"), "utf8")).toBe("/.ohmyhost/\n");
    const plain = await mkdtemp(join(tmpdir(), "ohmyhost-link-"));
    await new OwnerOnlyProjectLinkStore(join(plain, ".ohmyhost"), plain).save(
      link(AMERGED, AMERGED_PROJECT),
    );
    await expect(stat(join(plain, ".gitignore"))).rejects.toThrow();
  });
});

describe("owner-only project link store", () => {
  it("writes only non-secret metadata with owner-only permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "ohmyhost-link-"));
    const directory = join(root, ".ohmyhost");
    const store = new OwnerOnlyProjectLinkStore(directory);
    await store.save(link(AMERGED, AMERGED_PROJECT));

    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, "links"))).mode & 0o777).toBe(0o700);
    const file = join(directory, "links", `${AMERGED}.json`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const content = await readFile(file, "utf8");
    expect(JSON.parse(content)).toEqual(link(AMERGED, AMERGED_PROJECT));
    expect(content).not.toMatch(/token|secret|credential/u);
    await expect(
      store.save({ ...link(AMERGED, AMERGED_PROJECT), organization_id: "../x" }),
    ).rejects.toThrow("Invalid linked organization");
  });
});
