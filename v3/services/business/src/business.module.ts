import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BusinessEntity } from './entities/business.entity';
import { BusinessStaffEntity } from './entities/business-staff.entity';
import { BusinessOutboxEntity } from './entities/business-outbox.entity';
import { BusinessVerticalEntity } from './entities/business-vertical.entity';
import { BusinessTraitEntity } from './entities/business-trait.entity';
import { BusinessLocationEntity } from './entities/business-location.entity';
import { StaffRoleGrantEntity } from './entities/staff-role-grant.entity';
import { LocationResourceEntity } from './entities/location-resource.entity';
import { ServiceResourceRequirementEntity } from './entities/service-resource-requirement.entity';

import { BusinessService } from './business.service';
import { BusinessClassificationService } from './business-classification.service';
import { BusinessLocationService } from './business-location.service';
import { LocationResourceService } from './location-resource.service';
import { ServiceResourceRequirementService } from './service-resource-requirement.service';
import { StaffLocationService } from './staff-location.service';
import { StaffService } from './staff.service';
import { StaffGrantService } from './staff-grant.service';
import { BusinessScopedStaffAuthorizer } from './scoped-staff-authorizer.service';
import { STAFF_INVITE_CLOCK, SystemStaffInviteClock } from './staff-invite.clock';
import { BusinessController } from './business.controller';
import { BusinessLocationController } from './business-location.controller';
import { LocationResourceController } from './location-resource.controller';
import { ServiceResourceRequirementController } from './service-resource-requirement.controller';
import {
  BusinessManagerResolver,
  BusinessMembershipResolver,
  BusinessOwnerResolver,
  BusinessStaffSelfResolver,
} from './business-membership.resolver';
import { BusinessSubjectDataContract } from './business-subject-data.contract';

export const BUSINESS_ENTITIES = [
  BusinessEntity,
  BusinessStaffEntity,
  BusinessOutboxEntity,
  // V3.3 Story #107 (`#44a`). Registered here and nowhere else: the composition
  // root spreads this list onto the main DataSource, so a new business table
  // cannot be reachable at runtime while being invisible to the ORM.
  BusinessVerticalEntity,
  BusinessTraitEntity,
  // V3.3 Story #108 (`#44b`). Registered here and nowhere else, exactly as the
  // #107 tables above: the composition root spreads this list onto the main
  // DataSource, so a new business table cannot be reachable at runtime while
  // being invisible to the ORM.
  BusinessLocationEntity,
  // V3.3 Story #109 (`#44c`). Registered here and nowhere else, for the reason
  // the #107 and #108 lines above record.
  StaffRoleGrantEntity,
  // V3.3 Story #110 (`#110a`). Same reason as the three lines above: a new
  // business table must not be reachable at runtime while being invisible to
  // the ORM.
  LocationResourceEntity,
  // V3.3 Story #131 (`#127b`). Same reason as the four lines above: a new
  // business table must not be reachable at runtime while being invisible to
  // the ORM.
  ServiceResourceRequirementEntity,
];

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature(BUSINESS_ENTITIES)],
  controllers: [BusinessController, BusinessLocationController, LocationResourceController, ServiceResourceRequirementController],
  providers: [
    BusinessSubjectDataContract,
    BusinessService,
    BusinessClassificationService,
    // V3.3 Story #108 (`#44b`). It injects `LOCATION_CITY_CATALOGUE` and
    // `WORKSPACE_REFERENCE_SECRET`, both bound globally by `DomainPortsModule` --
    // `BusinessModule` declares neither, so a composition that omits the
    // composition root fails to boot rather than silently mis-wiring the city
    // check, the same shape `BUSINESS_OWNER_ROLE_GRANT` already uses.
    BusinessLocationService,
    // V3.3 Story #110 (`#110a`). Injects `WORKSPACE_REFERENCE_SECRET`, bound
    // globally by `DomainPortsModule` and not declared here, so a composition
    // that omits the composition root fails to boot rather than minting
    // references under an empty secret.
    LocationResourceService,
    // V3.3 Story #131 (`#127b`). Injects `SERVICE_OWNERSHIP_DIRECTORY`, bound
    // globally by `DomainPortsModule` -- a composition that omits the
    // composition root fails to boot rather than silently accepting a
    // requirement for a service nobody proved belongs to the caller.
    ServiceResourceRequirementService,
    // V3.3 Story #127 (`#127a`). Injects `WORKSPACE_REFERENCE_SECRET`, bound
    // globally by `DomainPortsModule`, for the same reason the location and
    // resource services do.
    StaffLocationService,
    StaffService,
    /*
     * V3.3 Story #109 (`#44c`).
     *
     * `StaffService` now injects `STAFF_INVITE_IDENTITY_RESOLVER` — declared
     * here, bound by `DomainPortsModule` — so a composition without the
     * composition root fails to boot rather than silently refusing every
     * invitation.
     *
     * `STAFF_INVITE_CLOCK` is bound to the real monotonic clock HERE rather than
     * at the root, because it is not a cross-domain seam: it exists so a
     * deterministic fake can prove the response-time floor applies to every
     * semantic path, including the exception path.
     *
     * `BusinessScopedStaffAuthorizer` implements `SCOPED_STAFF_AUTHORIZER`. It is
     * exported as a CLASS and deliberately not bound to its token here: nothing
     * inside `business` consumes the port, and the one consumer — chat's
     * seller-access adapter — resolves the token from the composition root, which
     * is what lets it ask the question without importing a `business` ORM entity.
     * The class holds no repository and no DataSource (every method takes the
     * caller's manager), so where it is instantiated changes nothing.
     */
    StaffGrantService,
    BusinessScopedStaffAuthorizer,
    { provide: STAFF_INVITE_CLOCK, useClass: SystemStaffInviteClock },
    BusinessMembershipResolver,
    BusinessOwnerResolver,
    BusinessManagerResolver,
    BusinessStaffSelfResolver,
  ],
  exports: [
    BusinessSubjectDataContract,
    BusinessService,
    BusinessClassificationService,
    BusinessLocationService,
    LocationResourceService,
    ServiceResourceRequirementService,
    StaffLocationService,
    StaffService,
    StaffGrantService,
    BusinessScopedStaffAuthorizer,
    STAFF_INVITE_CLOCK,
    BusinessMembershipResolver,
    TypeOrmModule,
  ],
})
export class BusinessModule {}
