import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  ObjectStorageDriver,
  StoredObjectHead,
  UploadTarget,
  UploadTargetRequest,
} from './object-storage.port';
import { SigV4Config, presignS3Url } from './sigv4';

/**
 * S3-compatible object storage.
 *
 * `V3_INFRASTRUCTURE_PLAN.md` §5 fixes the architecture as "S3-compatible,
 * Iran-reachable provider (ArvanCloud/Liara-class)" and names no vendor,
 * because the vendor follows the hosting/region decision
 * (`V3.1_PRODUCT_ROADMAP.md` §12 #1). This driver is written to that
 * architecture and to nothing narrower: it speaks plain S3 over HTTP with
 * SigV4 query authentication, path-style addressing by default, and no
 * vendor-specific extension anywhere. Selecting a provider is five
 * environment variables, not a code change -- which is the entire point of
 * ADR-006's provider-abstraction pattern being reused here rather than a
 * new one invented.
 *
 * `durable` is TRUE. It is verified against a real S3-compatible server
 * (MinIO) in CI, end to end: presign, PUT from a real HTTP client, HEAD,
 * ranged GET, DELETE. A hand-written signature that is wrong cannot pass
 * that suite, which is the only reason the signature is hand-written at all
 * (see `sigv4.ts`).
 *
 * WHAT IS STILL NOT VERIFIED, and must be recorded rather than implied:
 * no run against a real ARVANCLOUD OR LIARA endpoint has happened, because
 * no account exists to run one against. MinIO is the reference
 * implementation of the protocol, not a substitute for the chosen vendor's
 * quirks. `GAP-C-01` records that, exactly as `GAP-06b` records the
 * equivalent for the payment gateway.
 */
@Injectable()
export class S3ObjectStorageDriver implements ObjectStorageDriver {
  readonly key = 's3';
  readonly durable = true;

  private readonly config: SigV4Config;
  private readonly publicBaseUrl: string | null;

  constructor(config: ConfigService) {
    const required = (name: string): string => {
      const value = config.get<string>(name);
      if (!value) {
        // Fails at construction, not at first upload. A storage driver that
        // boots half-configured and fails on the customer's first attempt is
        // the failure mode env validation exists to prevent.
        throw new Error(`${name} is required when MEDIA_STORAGE_DRIVER=s3`);
      }
      return value;
    };

    this.config = {
      accessKeyId: required('MEDIA_S3_ACCESS_KEY_ID'),
      secretAccessKey: required('MEDIA_S3_SECRET_ACCESS_KEY'),
      region: config.get<string>('MEDIA_S3_REGION') ?? 'us-east-1',
      endpoint: required('MEDIA_S3_ENDPOINT').replace(/\/+$/, ''),
      bucket: required('MEDIA_S3_BUCKET'),
      forcePathStyle: (config.get<string>('MEDIA_S3_FORCE_PATH_STYLE') ?? 'true') !== 'false',
    };

    // Where PUBLIC objects are read from by a browser -- a CDN origin, or the
    // bucket itself when it is public-read. Null means "this deployment has
    // no public read path", and `MediaService` then refuses to mark anything
    // public rather than handing out a URL that 403s.
    this.publicBaseUrl = config.get<string>('MEDIA_S3_PUBLIC_BASE_URL')?.replace(/\/+$/, '') ?? null;
  }

  async createUploadTarget(request: UploadTargetRequest): Promise<UploadTarget> {
    const url = presignS3Url(this.config, {
      method: 'PUT',
      objectKey: request.objectKey,
      expiresInSeconds: request.expiresInSeconds,
      signedHeaders: { 'content-type': request.contentType },
    });

    return {
      url,
      method: 'PUT',
      // `content-type` is SIGNED, so the client must send exactly this or the
      // store rejects the request. `content-length` is not signed and is
      // listed only because an HTTP client needs it; the authoritative size
      // check is at finalize. See sigv4.ts for why.
      headers: {
        'content-type': request.contentType,
        'content-length': String(request.declaredByteSize),
      },
      expiresAt: new Date(Date.now() + request.expiresInSeconds * 1000),
    };
  }

  /** A short-lived presigned URL this process uses for its own reads/deletes. */
  private selfSignedUrl(method: 'GET' | 'HEAD' | 'DELETE', objectKey: string): string {
    return presignS3Url(this.config, { method, objectKey, expiresInSeconds: 60 });
  }

  async head(objectKey: string): Promise<StoredObjectHead> {
    const response = await fetch(this.selfSignedUrl('HEAD', objectKey), { method: 'HEAD' });
    if (response.status === 404 || response.status === 403) {
      // 403 is folded into "absent" deliberately. A bucket configured to deny
      // listing answers 403 for a missing key, and treating that as an error
      // would make a correctly-locked-down bucket look broken.
      return { exists: false, byteSize: null, contentType: null };
    }
    if (!response.ok) throw new Error(`Object store HEAD failed with ${response.status}`);

    const length = response.headers.get('content-length');
    return {
      exists: true,
      byteSize: length === null ? null : Number(length),
      contentType: response.headers.get('content-type'),
    };
  }

  async readRange(objectKey: string, start: number, endInclusive: number): Promise<Buffer> {
    const response = await fetch(this.selfSignedUrl('GET', objectKey), {
      method: 'GET',
      headers: { range: `bytes=${start}-${endInclusive}` },
    });
    if (!response.ok && response.status !== 206) {
      throw new Error(`Object store ranged GET failed with ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async read(objectKey: string): Promise<Buffer> {
    const response = await fetch(this.selfSignedUrl('GET', objectKey), { method: 'GET' });
    if (!response.ok) throw new Error(`Object store GET failed with ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  async delete(objectKey: string): Promise<void> {
    const response = await fetch(this.selfSignedUrl('DELETE', objectKey), { method: 'DELETE' });
    // S3 answers 204 for both "deleted" and "was not there", which is the
    // idempotency the port requires. 404 is accepted for stores that answer
    // it instead.
    if (!response.ok && response.status !== 404) {
      throw new Error(`Object store DELETE failed with ${response.status}`);
    }
  }

  publicUrl(objectKey: string): string | null {
    return this.publicBaseUrl ? `${this.publicBaseUrl}/${objectKey}` : null;
  }
}
