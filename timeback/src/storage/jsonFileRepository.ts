import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { MemoryRepository, emptySnapshot, type Snapshot } from './memoryRepository.ts';

/** Single-file JSON store for local prototyping. Not safe for concurrent writers. */
export class JsonFileRepository extends MemoryRepository {
  private readonly path: string;

  private constructor(path: string, data: Snapshot) {
    super(data);
    this.path = path;
  }

  static async open(path: string): Promise<JsonFileRepository> {
    let data = emptySnapshot();
    try {
      data = { ...data, ...JSON.parse(await readFile(path, 'utf8')) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return new JsonFileRepository(path, data);
  }

  protected override async changed(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2));
    await rename(tmp, this.path);
  }
}
