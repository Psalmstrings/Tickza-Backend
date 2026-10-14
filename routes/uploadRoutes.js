import express from 'express';
import { upload, processUpload } from '../middleware/uploadMiddleware.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

// @desc    Upload a single image (Cloudinary or local fallback)
// @route   POST /api/upload/image
// @access  Private
router.post(
  '/image',
  protect,
  upload.single('image'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'No image file provided.' });
      }

      const folder = req.query.folder || 'tickapp';
      const result = await processUpload(req.file, folder, req);

      return res.json({
        success: true,
        message: 'Image uploaded successfully.',
        data:    result,
        url:     result.url,
      });
    } catch (error) {
      console.error('[Upload Route Error]', error);
      return res.status(500).json({ success: false, message: error.message });
    }
  }
);

export default router;
