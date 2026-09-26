import { Controller, Get, Header, Query } from '@nestjs/common';
import { AuthenticatedUser, CurrentUser } from '@beauclick/http';

import { MyWorkspacesService, SellerWorkspaceEntry } from './my-workspaces.service';

/** For a route that accepts no query parameters. Any parameter is a validation failure. */
export class EmptyWorkspacesQueryDto {}

/**
 * `GET /api/v1/me/workspaces` — every seller workspace the session OWNS,
 * V3.3 #210. See `MyWorkspacesService` for why this is not the finance list.
 *
 * The security boundary is an authenticated caller and live ownership, read
 * on every request. No capability: listing what you own is not an action, and
 * every route a listed reference is then handed to carries its own guard and
 * its own live ownership match — this list only decides what a client OFFERS.
 *
 * An empty collection for a caller who owns nothing, never a `404`: being a
 * customer is a legitimate state, and a `404` would make "you are not a
 * seller" indistinguishable from "no such route".
 *
 * `private, no-store`, like the finance surface: the body carries references
 * bound to this session and the seller's own names, and a shared cache must
 * never hand one session's list to another.
 */
@Controller('v1/me/workspaces')
export class MyWorkspacesController {
  constructor(private readonly workspaces: MyWorkspacesService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() _query: EmptyWorkspacesQueryDto,
  ): Promise<{ items: SellerWorkspaceEntry[] }> {
    return { items: await this.workspaces.workspacesFor(user.userId) };
  }
}
