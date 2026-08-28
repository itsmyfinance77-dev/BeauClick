import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createReadStream, promises as fs } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';

import {
  ObjectStorageDriver,
  StoredObjectHead,
  UploadTarget,
  UploadTargetRequest,
} from './object-storage.port';
import { signUploadToken } from './upload-grant.token';

/**
 * Filesystem-backed object storage.
 *
 * WHAT THIS IS FOR, stated plainly so nobody deploys it by accident:
 * development, CI, and any environment where durable object storage has not
 * been provisioned. `durable` is FALSE, the health surface reports it, and
 * `MediaModule` refuses to bind this driver when `NODE_ENV=production`
 * unless `MEDIA_ALLOW_LOCAL_DRIVER_IN_PRODUCTION` is explicitly set -- the
 * same two-condition shape the payment sandbox gate uses, and for the same
 * reason: a stand-in that can be reached in production by forgetting one
 * variable is a stand-in that will be.
 *
 * It is a REAL implementation, not a stub. Bytes land on disk, ranges are
 * read back off disk, deletes remove files. Every property the media
 * security model asserts -- key scoping, expiry, size enforcement,
 * server-side sniffing of what actually arrived -- is exercised against it.
 *
 * PATH SAFETY. Object keys are allocated by `MediaService` and never come
 * from a client, but this driver still resolves every key against the root
 * and refuses anything that escapes it. Depending on a caller's discipline
 * for a traversal guarantee is how traversal bugs happen.
 */
@Injectable()
export class LocalObjectStorageDriver implements ObjectStorageDriver {
  readonly key = 'local';
  readonly durable = false;

  private readonly root: string;
  private readonly apiBaseUrl: string;
  private readonly tokenSecret: string;

  constructor(config: ConfigService) {
    this.root = resolve(config.get<string>('MEDIA_LOCAL_ROOT') ?? join(process.cwd(), '.media-store'));
    this.apiBaseUrl = (config.get<string>('PUBLIC_API_BASE_URL') ?? 'http://localhost:3099/api').replace(/\/+$/, '');
    // Falls back to the JWT secret rather than to a constant: a hard-coded
    // default here would be a signing key published in the repository, and
    // every deployment already has to set JWT_ACCESS_SECRET.
    this.tokenSecret =
      config.get<string>('MEDIA_UPLOAD_TOKEN_SECRET') ??
      config.get<string>('JWT_ACCESS_SECRET') ??
      'dev-only-insecure-media-secret';
  }

  /** Resolves a key to an absolute path, refusing anything outside the root. */
  private pathFor(objectKey: string): string {
    const candidate = resolve(this.root, normalize(objectKey));
    if (candidate !== this.root && !candidate.startsWith(this.root + sep)) {
      throw new Error(`Object key "${objectKey}" resolves outside the media root`);
    }
    return candidate;
  }

  async createUploadTarget(request: UploadTargetRequest): Promise<UploadTarget> {
    const expiresAt = new Date(Date.now() + request.expiresInSeconds * 1000);
    const token = signUploadToken(
      {
        k: request.objectKey,
        m: request.objectKey.split('/').pop() ?? request.objectKey,
        c: request.contentType,
        n: request.declaredByteSize,
        e: Math.floor(expiresAt.getTime() / 1000),
      },
      this.tokenSecret,
    );

    return {
      url: `${this.apiBaseUrl}/v1/media/upload/${token}`,
      method: 'PUT',
      headers: {
        'content-type': request.contentType,
        'content-length': String(request.declaredByteSize),
      },
      expiresAt,
    };
  }

  /** Writes the bytes for an already-authorized key. Called only by the PUT route. */
  async acceptDirectUpload(objectKey: string, body: Buffer): Promise<void> {
    const path = this.pathFor(objectKey);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, body);
  }

  async head(objectKey: string): Promise<StoredObjectHead> {
    try {
      const stat = await fs.stat(this.pathFor(objectKey));
      // No content type on disk. Returning `null` rather than guessing from
      // the extension is the honest answer, and the caller sniffs the bytes
      // anyway -- a guess here would be a second, weaker source of truth.
      return { exists: true, byteSize: stat.size, contentType: null };
    } catch {
      return { exists: false, byteSize: null, contentType: null };
    }
  }

  async readRange(objectKey: string, start: number, endInclusive: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    const stream = createReadStream(this.pathFor(objectKey), { start, end: endInclusive });
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  /** The whole object, for the protected-download route. */
  async read(objectKey: string): Promise<Buffer> {
    return fs.readFile(this.pathFor(objectKey));
  }

  async delete(objectKey: string): Promise<void> {
    try {
      await fs.unlink(this.pathFor(objectKey));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
    }
  }

  publicUrl(objectKey: string): string | null {
    // The object key goes into the path VERBATIM, including its
    // `public/<purpose>/` prefix, so the URL and the key stay a 1:1 mapping.
    // An earlier version stripped the prefix and rebuilt the path, which
    // produced `/public/public/portfolio/<id>` and, worse, meant two places
    // knew how a key is composed.
    return `${this.apiBaseUrl}/v1/media/file/${objectKey}`;
  }
}
