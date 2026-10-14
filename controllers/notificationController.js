import { Notification } from '../models/Notification.js';

// @desc    Get current user's notifications (paginated, newest first)
// @route   GET /api/notifications
// @access  Private
export const getMyNotifications = async (req, res) => {
  try {
    const { page = 1, limit = 20, unreadOnly = 'false' } = req.query;
    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const query = { userId: req.user._id };
    if (unreadOnly === 'true') {
      query.read = false;
    }

    const [notifications, total] = await Promise.all([
      Notification.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit, 10)),
      Notification.countDocuments(query),
    ]);

    return res.json({
      success: true,
      total,
      page:  parseInt(page, 10),
      pages: Math.ceil(total / parseInt(limit, 10)),
      data:  notifications,
    });
  } catch (error) {
    console.error('[Notification getMyNotifications Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Mark a single notification as read
// @route   PATCH /api/notifications/:id/read
// @access  Private
export const markRead = async (req, res) => {
  try {
    const notification = await Notification.findById(req.params.id);

    if (!notification) {
      return res.status(404).json({ success: false, message: 'Notification not found.' });
    }

    // Ensure the notification belongs to the requesting user
    if (notification.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Not authorised to update this notification.' });
    }

    if (notification.read) {
      // Already read — return silently
      return res.json({ success: true, message: 'Notification is already marked as read.', data: notification });
    }

    notification.read = true;
    await notification.save();

    return res.json({ success: true, message: 'Notification marked as read.', data: notification });
  } catch (error) {
    console.error('[Notification markRead Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Mark all of the user's unread notifications as read
// @route   PATCH /api/notifications/read-all
// @access  Private
export const markAllRead = async (req, res) => {
  try {
    const result = await Notification.updateMany(
      { userId: req.user._id, read: false },
      { $set: { read: true } }
    );

    return res.json({
      success: true,
      message: `${result.modifiedCount} notification(s) marked as read.`,
      modifiedCount: result.modifiedCount,
    });
  } catch (error) {
    console.error('[Notification markAllRead Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get count of unread notifications for the current user
// @route   GET /api/notifications/unread-count
// @access  Private
export const getUnreadCount = async (req, res) => {
  try {
    const count = await Notification.countDocuments({ userId: req.user._id, read: false });
    return res.json({ success: true, count });
  } catch (error) {
    console.error('[Notification getUnreadCount Error]', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
