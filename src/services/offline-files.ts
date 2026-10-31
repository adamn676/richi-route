// The offline areas' files in the origin's private file system, under the catalogue's paths ("areas/at-6/map.pmtiles").
async function directoryOf(path: string, create: boolean): Promise<[FileSystemDirectoryHandle, string]> {
  const parts = path.split('/'), name = parts.pop()!;
  let directory = await navigator.storage.getDirectory();
  for (const part of parts) directory = await directory.getDirectoryHandle(part, { create });
  return [directory, name];
}

export async function fileHandle(path: string, create = false): Promise<FileSystemFileHandle> {
  const [directory, name] = await directoryOf(path, create);
  return directory.getFileHandle(name, { create });
}

// The file as stored, or null when it is not there.
export async function storedFile(path: string): Promise<File | null> {
  try { return await (await fileHandle(path)).getFile(); }
  catch (error) { if ((error as DOMException).name === 'NotFoundError') return null; throw error; }
}

export async function removeFile(path: string): Promise<void> {
  try {
    const [directory, name] = await directoryOf(path, false);
    await directory.removeEntry(name);
  } catch (error) {
    if ((error as DOMException).name !== 'NotFoundError') throw error;
  }
}
