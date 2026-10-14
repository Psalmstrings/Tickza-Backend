import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { cloudinary, isCloudinaryConfigured } from '../config/cloudinary.js';

const uploadDir = path.resolve('uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, uniqueName);
  },
});

const fileFilter = (req, file, cb) => {
  const allowed = /jpeg|jpg|png|webp/;
  const ext = allowed.test(path.extname(file.originalname).toLowerCase());
  const mime = allowed.test(file.mimetype);

  if (ext && mime) {
    cb(null, true);
  } else {
    cb(new Error('Only JPG, PNG, and WEBP image files are allowed.'));
  }
};

export const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter,
});

/**
 * Upload an image file either to Cloudinary (if configured) or local uploads folder.
 */
export const processUpload = async (file, folder = 'tickapp', req = null) => {
  if (!file) return null;

  if (isCloudinaryConfigured) {
    try {
      const result = await cloudinary.uploader.upload(file.path, {
        folder,
        resource_type: 'image',
      });
      // Clean up local temp file after Cloudinary upload
      try {
        fs.unlinkSync(file.path);
      } catch (e) {}

      return {
        url: result.secure_url,
        publicId: result.public_id,
        width: result.width,
        height: result.height,
      };
    } catch (err) {
      console.warn('[Cloudinary Upload Error]', err.message);
      // Fallback to local
    }
  }

  // Local fallback with absolute URL
  const baseUrl = process.env.BASE_URL || (req ? `${req.protocol}://${req.get('host')}` : `http://localhost:${process.env.PORT || 5090}`);
  return {
    url: `${baseUrl}/uploads/${file.filename}`,
    relativeUrl: `/uploads/${file.filename}`,
    publicId: `local/${file.filename}`,
    width: 800,
    height: 600,
  };
};
