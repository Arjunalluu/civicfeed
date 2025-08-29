const express = require('express');
const multer = require('multer');
const path = require('path');
const auth = require('../middleware/auth');
const Post = require('../models/Post');

const router = express.Router();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: function (req, file, cb) {
    const filetypes = /jpeg|jpg|png|gif|mp4|mov|avi/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = filetypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only image and video files are allowed'));
    }
  }
});

// Get all posts with optional filters
router.get('/', async (req, res) => {
  try {
    const { category, status, near, limit = 20, page = 1 } = req.query;
    let query = {};
    
    // Filter by category
    if (category) {
      query.category = category;
    }
    
    // Filter by status
    if (status) {
      query.status = status;
    }
    
    // Filter by location (nearby posts)
    if (near) {
      const [lat, lng, radius = 5000] = near.split(',').map(Number);
      query.location = {
        $near: {
          $geometry: {
            type: "Point",
            coordinates: [lng, lat]
          },
          $maxDistance: radius
        }
      };
    }
    
    const posts = await Post.find(query)
      .populate('author', 'name')
      .populate('assignedTo', 'name department')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));
    
    res.json(posts);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get posts by current user - This must come BEFORE the /:id route
router.get('/user', auth, async (req, res) => {
  try {
    const posts = await Post.find({ author: req.user.userId })
      .populate('author', 'name')
      .populate('assignedTo', 'name department')
      .sort({ createdAt: -1 });
    
    res.json(posts);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get a specific post - This must come AFTER the /user route
router.get('/:id', async (req, res) => {
  try {
    const post = await Post.findById(req.params.id)
      .populate('author', 'name')
      .populate('assignedTo', 'name department')
      .populate('comments.user', 'name');
    
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }
    
    res.json(post);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Create a new post
router.post('/', auth, upload.single('media'), async (req, res) => {
  try {
    const { title, description, category, lat, lng, address } = req.body;
    
    let mediaUrl = null;
    if (req.file) {
      mediaUrl = `/uploads/${req.file.filename}`;
    }
    
    const post = new Post({
      title,
      description,
      category,
      location: {
        type: 'Point',
        coordinates: [parseFloat(lng), parseFloat(lat)],
        address
      },
      author: req.user.userId,
      imageUrl: req.file && req.file.mimetype.startsWith('image') ? mediaUrl : null,
      videoUrl: req.file && req.file.mimetype.startsWith('video') ? mediaUrl : null
    });
    
    await post.save();
    await post.populate('author', 'name');
    
    res.status(201).json(post);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Update a post (status, assignment, etc.)
router.put('/:id', auth, async (req, res) => {
  try {
    const { status, assignedTo } = req.body;
    const post = await Post.findById(req.params.id);
    
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }
    
    // Only author or municipal workers can update
    if (post.author.toString() !== req.user.userId && req.user.role !== 'municipal') {
      return res.status(403).json({ message: 'Not authorized' });
    }
    
    if (status) post.status = status;
    if (assignedTo) post.assignedTo = assignedTo;
    
    await post.save();
    await post.populate('author', 'name')
              .populate('assignedTo', 'name department')
              .populate('comments.user', 'name');
    
    res.json(post);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Add a comment to a post
router.post('/:id/comments', auth, async (req, res) => {
  try {
    const { text } = req.body;
    const post = await Post.findById(req.params.id);
    
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }
    
    post.comments.push({
      user: req.user.userId,
      text
    });
    
    await post.save();
    await post.populate('comments.user', 'name');
    
    res.json(post.comments);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Like a post
router.post('/:id/like', auth, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }
    
    // Check if user already liked
    const hasLiked = post.likes.includes(req.user.userId);
    
    if (hasLiked) {
      // Remove like
      post.likes = post.likes.filter(
        userId => userId.toString() !== req.user.userId
      );
    } else {
      // Add like
      post.likes.push(req.user.userId);
    }
    
    await post.save();
    res.json({ 
      likes: post.likes.length, 
      userLiked: !hasLiked 
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Upvote a post (keep this for backward compatibility)
router.post('/:id/upvote', auth, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }
    
    // Check if user already upvoted
    const hasUpvoted = post.upvotes.includes(req.user.userId);
    
    if (hasUpvoted) {
      // Remove upvote
      post.upvotes = post.upvotes.filter(
        userId => userId.toString() !== req.user.userId
      );
    } else {
      // Add upvote
      post.upvotes.push(req.user.userId);
    }
    
    await post.save();
    res.json({ upvotes: post.upvotes.length, hasUpvoted: !hasUpvoted });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

module.exports = router;