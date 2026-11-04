/**
 * Notifications module — persistent in-app records. Delivery adapters
 * (email/push) plug in later; records are always written first.
 */
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

export interface NotifyInput {
  userId: string;
  type: string;
  title: string;
  body: string;
  link?: string;
}

export async function notify(input: NotifyInput, tx?: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]): Promise<void> {
  const data = { userId: input.userId, type: input.type, title: input.title, body: input.body, link: input.link };
  try {
    if (tx) await tx.notification.create({ data });
    else await prisma.notification.create({ data });
  } catch (e) {
    logger.error("notification_write_failed", { type: input.type, error: String(e) });
  }
}

export async function listNotifications(userId: string, unreadOnly = false) {
  return prisma.notification.findMany({
    where: { userId, ...(unreadOnly ? { readAt: null } : {}) },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}

export async function markRead(userId: string, notificationId: string): Promise<void> {
  await prisma.notification.updateMany({
    where: { id: notificationId, userId },
    data: { readAt: new Date() },
  });
}

export async function markAllRead(userId: string): Promise<void> {
  await prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
}
