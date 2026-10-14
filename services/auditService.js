import { AuditLog } from '../models/AuditLog.js';

export const logAudit = async ({
  actorId,
  actorName,
  actorRole,
  action,
  targetType,
  targetId,
  details = {},
  req,
}) => {
  try {
    const ipAddress = req
      ? req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || ''
      : '';
    const userAgent = req ? req.headers?.['user-agent'] || '' : '';

    await AuditLog.create({
      actorId,
      actorName: actorName || (actorRole === 'SYSTEM' ? 'System' : 'Unknown'),
      actorRole: actorRole || 'USER',
      action,
      targetType,
      targetId: targetId ? targetId.toString() : '',
      details,
      ipAddress,
      userAgent,
    });
  } catch (error) {
    console.error('[Audit Log Error]', error.message);
  }
};
