import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthContext } from '../auth/auth.context';
import { ProblemException } from '../common/problem';
import { isUuid } from '../common/uuid';
import { PrismaService } from '../prisma/prisma.service';

interface NotificationDto {
  id: string;
  kind: string;
  channel: string;
  subject: string;
  body: string;
  state: string;
  createdAt: string;
  deliveredAt: string | null;
  readAt: string | null;
}

@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @HttpCode(200)
  @ApiOperation({ summary: 'List inbox + recent notifications' })
  async list(
    @CurrentUser() user: AuthContext,
    @Query('unread') unread?: string,
  ): Promise<{ notifications: NotificationDto[]; unreadCount: number }> {
    const where = {
      tenantId: user.tenantId,
      userId: user.userId,
      channel: 'in_app' as const,
      ...(unread === '1' ? { readAt: null } : {}),
    };
    const [rows, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.notification.count({
        where: { tenantId: user.tenantId, userId: user.userId, channel: 'in_app', readAt: null },
      }),
    ]);
    return {
      notifications: rows.map((n) => ({
        id: n.id,
        kind: n.kind,
        channel: n.channel,
        subject: n.subject,
        body: n.body,
        state: n.state,
        createdAt: n.createdAt.toISOString(),
        deliveredAt: n.deliveredAt?.toISOString() ?? null,
        readAt: n.readAt?.toISOString() ?? null,
      })),
      unreadCount,
    };
  }

  @Post(':id/read')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark an in-app notification as read' })
  async markRead(
    @CurrentUser() user: AuthContext,
    @Param('id') id: string,
  ): Promise<{ id: string; readAt: string }> {
    if (!isUuid(id)) {
      throw new ProblemException({
        status: 404,
        code: 'notifications.not-found',
        title: 'Notification not found',
      });
    }
    const existing = await this.prisma.notification.findFirst({
      where: { id, tenantId: user.tenantId, userId: user.userId },
    });
    if (!existing) {
      throw new ProblemException({
        status: 404,
        code: 'notifications.not-found',
        title: 'Notification not found',
      });
    }
    const updated = await this.prisma.notification.update({
      where: { id: existing.id },
      data: { state: 'read', readAt: new Date() },
    });
    return { id: updated.id, readAt: updated.readAt!.toISOString() };
  }
}
