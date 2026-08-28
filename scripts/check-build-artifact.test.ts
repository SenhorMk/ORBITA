import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkBuildArtifact } from './check-build-artifact.mjs';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeArtifactDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orbita-artifact-check-'));
  temporaryDirectories.push(dir);
  mkdirSync(join(dir, 'static'), { recursive: true });
  mkdirSync(join(dir, 'server'), { recursive: true });
  return dir;
}

describe('checkBuildArtifact', () => {
  it('passes for a clean artifact with only public assets', () => {
    const dir = makeArtifactDir();
    writeFileSync(join(dir, 'static', 'chunk.js'), 'console.log(process.env.NEXT_PUBLIC_SUPABASE_URL);', 'utf8');
    writeFileSync(join(dir, 'server', 'route.js'), 'const key = process.env.SUPABASE_SERVICE_ROLE_KEY;', 'utf8');

    const result = checkBuildArtifact(dir);

    expect(result.valid).toBe(true);
    expect(result.forbiddenPaths).toEqual([]);
    expect(result.leakedClientStrings).toEqual([]);
  });

  it('fails when a development metadata directory is shipped in the artifact', () => {
    const dir = makeArtifactDir();
    mkdirSync(join(dir, '.scratch'), { recursive: true });
    writeFileSync(join(dir, '.scratch', 'notes.txt'), 'todo', 'utf8');

    const result = checkBuildArtifact(dir);

    expect(result.valid).toBe(false);
    expect(result.forbiddenPaths).toEqual([expect.stringContaining('.scratch')]);
  });

  it('fails when an .env file is shipped in the artifact', () => {
    const dir = makeArtifactDir();
    writeFileSync(join(dir, '.env.local'), 'SECRET=1', 'utf8');

    const result = checkBuildArtifact(dir);

    expect(result.valid).toBe(false);
    expect(result.forbiddenPaths).toEqual([expect.stringContaining('.env.local')]);
  });

  it('fails when a non-public secret name leaks into a client-servable asset', () => {
    const dir = makeArtifactDir();
    writeFileSync(
      join(dir, 'static', 'chunk.js'),
      'const leaked = "SUPABASE_SERVICE_ROLE_KEY value inlined by mistake";',
      'utf8',
    );

    const result = checkBuildArtifact(dir);

    expect(result.valid).toBe(false);
    expect(result.leakedClientStrings).toEqual([
      { file: expect.stringContaining('chunk.js'), matches: ['SUPABASE_SERVICE_ROLE_KEY'] },
    ]);
  });

  it('reports an invalid result when the artifact directory does not exist', () => {
    const result = checkBuildArtifact(join(tmpdir(), 'orbita-artifact-check-does-not-exist'));

    expect(result.valid).toBe(false);
    expect(result.forbiddenPaths[0]).toContain('artifact directory not found');
  });
});
