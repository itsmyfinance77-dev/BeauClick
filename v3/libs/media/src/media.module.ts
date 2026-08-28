import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MediaObjectEntity } from './entities/media-object.entity';
import { MediaAbuseReportEntity } from './entities/media-abuse-report.entity';
import { MediaService } from './media.service';
import { AdminMediaController, MediaController } from './media.controller';
import { OBJECT_STORAGE_DRIVER, ObjectStorageDriver } from './storage/object-storage.port';
import { LocalObjectStorageDriver } from './storage/local-object-storage.driver';
import { S3ObjectStorageDriver } from './storage/s3-object-storage.driver';
import { MediaSubjectDataContract } from './media-subject-data.contract';

export const MEDIA_ENTITIES = [MediaObjectEntity, MediaAbuseReportEntity];

/**
 * Chooses the storage driver, once, at boot.
 *
 * TWO CONDITIONS TO REACH THE NON-DURABLE DRIVER IN PRODUCTION, and no
 * override that collapses them into one. This is the same shape as the
 * payment sandbox gate, deliberately, and for a reason that generalizes:
 * V2 shipped a "local development only" payment stand-in whose
 * production-safety was a sentence in the UI with no mechanism behind it,
 * and Phase 2 found it still reachable. A filesystem-backed object store in
 * production means every portfolio image and every identity document lives
 * on one container's ephemeral disk, and disappears with it.
 *
 * `MEDIA_STORAGE_DRIVER` defaults to `local`, which is right for
 * development and CI and wrong for production -- so production must both
 * fail to set it AND set the escape hatch before it can boot on local
 * storage.
 */
function createStorageDriver(config: ConfigService): ObjectStorageDriver {
  const requested = (config.get<string>('MEDIA_STORAGE_DRIVER') ?? 'local').toLowerCase();

  if (requested === 's3') return new S3ObjectStorageDriver(config);

  if (requested !== 'local') {
    throw new Error(`Unknown MEDIA_STORAGE_DRIVER "${requested}". Valid values: local, s3.`);
  }

  const isProduction = (config.get<string>('NODE_ENV') ?? 'development') === 'production';
  const escapeHatch = config.get<string>('MEDIA_ALLOW_LOCAL_DRIVER_IN_PRODUCTION') === 'true';
  if (isProduction && !escapeHatch) {
    throw new Error(
      'MEDIA_STORAGE_DRIVER=local is refused in production: the local driver writes to this container\'s own disk ' +
        'and is reported as non-durable. Configure MEDIA_STORAGE_DRIVER=s3 with MEDIA_S3_* credentials, or set ' +
        'MEDIA_ALLOW_LOCAL_DRIVER_IN_PRODUCTION=true to accept the consequence deliberately.',
    );
  }

  return new LocalObjectStorageDriver(config);
}

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature(MEDIA_ENTITIES)],
  controllers: [MediaController, AdminMediaController],
  providers: [
    MediaSubjectDataContract,
    MediaService,
    {
      provide: OBJECT_STORAGE_DRIVER,
      inject: [ConfigService],
      useFactory: createStorageDriver,
    },
  ],
  exports: [
    MediaSubjectDataContract,MediaService, OBJECT_STORAGE_DRIVER, TypeOrmModule],
})
export class MediaModule {}
