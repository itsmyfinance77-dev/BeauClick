import 'reflect-metadata';
import { Controller, Get, Module, Post } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { RequireCapability } from '@beauclick/auth';
import { AuditAction, AuditExempt } from './audit-action.decorator';
import { AuditEnforcementService, assertPrivilegedMutationsAreAudited } from './audit-enforcement';

/**
 * The structural audit enforcement, proven by deliberate violation.
 *
 * This spec exists because of a specific failure mode: a discovery mechanism
 * that breaks by finding NOTHING passes forever and reads as a guarantee. That
 * is strictly worse than having no check, because it stops anyone looking.
 *
 * So the cases below assert both directions -- a declared mutation IS seen, and
 * an undeclared one DOES throw. Neither alone is evidence.
 *
 * V2 needed this: the same bug (a capability-gated admin mutation that skipped
 * its audit call) was found three separate times across two plugins before the
 * fix was made structural rather than remembered.
 */

@Controller('t/declared')
class DeclaredController {
  @RequireCapability('bc_manage_platform')
  @AuditAction('test.declared')
  @Post()
  mutate() {
    return null;
  }
}

@Controller('t/undeclared')
class UndeclaredController {
  @RequireCapability('bc_manage_platform')
  @Post()
  mutate() {
    return null;
  }
}

@Controller('t/exempt')
class ExemptController {
  @RequireCapability('bc_manage_platform')
  @AuditExempt('a deliberate, argued exemption with a stated reason')
  @Post()
  mutate() {
    return null;
  }
}

@Controller('t/read')
class ReadOnlyController {
  @RequireCapability('bc_manage_platform')
  @Get()
  read() {
    return null;
  }
}

@Controller('t/ordinary')
class OrdinaryController {
  // A non-privileged capability. Gating a mutation on `bc_book_service` is an
  // ordinary product action, not an administrative one.
  @RequireCapability('bc_book_service')
  @Post()
  mutate() {
    return null;
  }
}

@Controller('t/ungated')
class UngatedController {
  @Post()
  mutate() {
    return null;
  }
}

async function appWith(controllers: unknown[]) {
  @Module({ imports: [DiscoveryModule], controllers: controllers as never[], providers: [AuditEnforcementService] })
  class TestModule {}

  const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('structural audit enforcement', () => {
  it('SEES a declared privileged mutation', async () => {
    const app = await appWith([DeclaredController]);
    try {
      const found = app.get(AuditEnforcementService).privilegedMutations();
      // The load-bearing assertion of this whole file. If discovery breaks, it
      // breaks by returning [], and every "no offenders" case below would still
      // pass while enforcing nothing.
      expect(found).toHaveLength(1);
      expect(found[0].handler).toBe('DeclaredController.mutate');
      expect(found[0].auditAction).toBe('test.declared');
      expect(found[0].transactional).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('THROWS for an undeclared privileged mutation, naming it', async () => {
    const app = await appWith([UndeclaredController]);
    try {
      expect(() => assertPrivilegedMutationsAreAudited(app)).toThrow(/UndeclaredController\.mutate/);
      // The message must be actionable, not just a failure: whoever hits this
      // at boot needs to know what to do about it.
      expect(() => assertPrivilegedMutationsAreAudited(app)).toThrow(/@AuditAction/);
    } finally {
      await app.close();
    }
  });

  it('accepts a declared mutation', async () => {
    const app = await appWith([DeclaredController]);
    try {
      expect(() => assertPrivilegedMutationsAreAudited(app)).not.toThrow();
    } finally {
      await app.close();
    }
  });

  it('accepts an explicit exemption, and records its reason', async () => {
    const app = await appWith([ExemptController]);
    try {
      expect(() => assertPrivilegedMutationsAreAudited(app)).not.toThrow();
      const [route] = app.get(AuditEnforcementService).privilegedMutations();
      expect(route.auditExempt).toBe('a deliberate, argued exemption with a stated reason');
    } finally {
      await app.close();
    }
  });

  it('ignores reads -- auditing every GET would bury the mutations in noise', async () => {
    const app = await appWith([ReadOnlyController]);
    try {
      expect(app.get(AuditEnforcementService).privilegedMutations()).toHaveLength(0);
      expect(() => assertPrivilegedMutationsAreAudited(app)).not.toThrow();
    } finally {
      await app.close();
    }
  });

  it('ignores a mutation gated on a NON-privileged capability', async () => {
    const app = await appWith([OrdinaryController]);
    try {
      expect(app.get(AuditEnforcementService).privilegedMutations()).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('ignores an ungated mutation -- this enforces administrative audit, not all audit', async () => {
    const app = await appWith([UngatedController]);
    try {
      expect(app.get(AuditEnforcementService).privilegedMutations()).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('finds the one offender among several compliant routes', async () => {
    const app = await appWith([DeclaredController, ExemptController, ReadOnlyController, UndeclaredController]);
    try {
      const unaudited = app.get(AuditEnforcementService).unaudited();
      expect(unaudited).toHaveLength(1);
      expect(unaudited[0].handler).toBe('UndeclaredController.mutate');
    } finally {
      await app.close();
    }
  });

  it('refuses a non-transactional declaration with no stated reason, at decoration time', () => {
    // Thrown when the module is loaded, so it cannot reach a running system.
    expect(() => AuditAction('test.action', { transactional: false })).toThrow(/because/);
    expect(() => AuditAction('test.action', { transactional: false, because: 'a real reason' })).not.toThrow();
  });
});
