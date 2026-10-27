
require('dotenv').config()

const express = require('express')
const cors = require('cors')
const mongoose = require('mongoose')
const multer = require('multer')
const path = require('path')
const fs = require('fs')
const jwt = require('jsonwebtoken')

const User = require('./models/User')

const app = express()
const PORT = 5000

app.use(cors())
app.use(express.json({ limit: '1mb' }))

app.use('/api/auth', require('./routes/auth'))

const uploadDir = path.join(__dirname, 'uploads')
fs.mkdirSync(uploadDir, { recursive: true })
app.use('/uploads', express.static(uploadDir))

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`)
  }
})

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'video/mp4', 'video/webm', 'video/quicktime'
    ]
    if (allowed.includes(file.mimetype)) return cb(null, true)
    cb(new Error('Use JPG, PNG, GIF, WEBP, MP4 or WEBM.'))
  }
})

const commentSchema = new mongoose.Schema({
  user: { type: String, default: 'You', maxlength: 40 },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  text: { type: String, required: true, maxlength: 500 },
  createdAt: { type: Date, default: Date.now }
})

const postSchema = new mongoose.Schema({
  username: { type: String, default: 'You', required: true },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  text: { type: String, default: '', maxlength: 2200 },
  likes: { type: Number, default: 0, min: 0 },
  likedBy: { type: [String], default: [] },
  likedByIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  comments: { type: [commentSchema], default: [] },
  mediaUrl: { type: String, default: '' },
  mediaType: { type: String, enum: ['', 'image', 'video'], default: '' },
  archived: { type: Boolean, default: false }
}, { timestamps: true })

const Post = mongoose.models.Post || mongoose.model('Post', postSchema)

const storySchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  username: { type: String, required: true },
  mediaUrl: { type: String, required: true },
  mediaType: { type: String, enum: ['image', 'video'], required: true },
  viewers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 24 * 60 * 60 * 1000)
  }
}, { timestamps: true })

const Story = mongoose.models.Story || mongoose.model('Story', storySchema)

const highlightSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true, maxlength: 40 },
  stories: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Story' }],
  coverUrl: { type: String, default: '' }
}, { timestamps: true })

const Highlight = mongoose.models.Highlight || mongoose.model('Highlight', highlightSchema)

function formatPost(post) {
  return {
    id: post._id.toString(),
    username: post.username,
    owner: post.owner ? post.owner.toString() : null,
    text: post.text,
    likes: post.likes || 0,
    likedBy: post.likedBy || [],
    comments: (post.comments || []).map(c => ({
      id: c._id.toString(),
      user: c.user,
      userId: c.userId ? c.userId.toString() : null,
      text: c.text,
      createdAt: c.createdAt
    })),
    mediaUrl: post.mediaUrl || '',
    mediaType: post.mediaType || '',
    archived: Boolean(post.archived),
    createdAt: post.createdAt
  }
}

function formatStory(story) {
  return {
    id: story._id.toString(),
    owner: story.owner.toString(),
    username: story.username,
    mediaUrl: story.mediaUrl,
    mediaType: story.mediaType,
    viewers: (story.viewers || []).map(id => id.toString()),
    viewCount: (story.viewers || []).length,
    expiresAt: story.expiresAt,
    createdAt: story.createdAt
  }
}

function auth(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''

  if (!token) {
    return res.status(401).json({ message: 'Please log in to continue.' })
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    req.userId = decoded.userId
    next()
  } catch {
    return res.status(401).json({ message: 'Your session expired. Please log in again.' })
  }
}

async function currentUser(req) {
  return User.findById(req.userId)
}

async function ownedPost(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(400).json({ message: 'Invalid post ID.' })
    return null
  }

  const post = await Post.findById(req.params.id)

  if (!post) {
    res.status(404).json({ message: 'Post not found.' })
    return null
  }

  if (!post.owner || post.owner.toString() !== req.userId) {
    res.status(403).json({
      message: 'This post belongs to an older account or another user. Ownership cannot be verified.'
    })
    return null
  }

  return post
}

app.get('/', (req, res) => {
  res.json({ message: 'Connectly backend is running!' })
})

// Logged-in account information
app.get('/api/auth/me', auth, async (req, res) => {
  const user = await currentUser(req)
  if (!user) return res.status(404).json({ message: 'Account not found.' })

  res.json({
    id: user._id,
    username: user.username,
    email: user.email,
    bio: user.bio || '',
    followers: user.followers.length,
    following: user.following.length
  })
})

// Search all registered accounts
app.get('/api/users/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim()

    if (q.length < 1) return res.json([])

    const users = await User.find({
      username: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }
    }).select('username bio followers following').limit(30)

    res.json(users.map(user => ({
      id: user._id,
      username: user.username,
      bio: user.bio || '',
      followers: user.followers.length,
      following: user.following.length
    })))
  } catch (err) {
    console.error('USER SEARCH:', err.message)
    res.status(500).json({ message: 'Could not search users.' })
  }
})

// Public user profile and their public posts
app.get('/api/users/:username', async (req, res) => {
  try {
    const user = await User.findOne({
      username: req.params.username
    }).select('username bio followers following createdAt')

    if (!user) return res.status(404).json({ message: 'User not found.' })

    const userPosts = await Post.find({
      owner: user._id,
      archived: false
    }).sort({ createdAt: -1 })

    res.json({
      user: {
        id: user._id,
        username: user.username,
        bio: user.bio || '',
        followers: user.followers.length,
        following: user.following.length,
        createdAt: user.createdAt
      },
      posts: userPosts.map(formatPost)
    })
  } catch (err) {
    console.error('PROFILE:', err.message)
    res.status(500).json({ message: 'Could not load profile.' })
  }
})

// Follow a user or unfollow them
app.post('/api/users/:id/follow', auth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid user ID.' })
    }

    if (req.params.id === req.userId) {
      return res.status(400).json({ message: 'You cannot follow yourself.' })
    }

    const [me, target] = await Promise.all([
      User.findById(req.userId),
      User.findById(req.params.id)
    ])

    if (!me || !target) {
      return res.status(404).json({ message: 'Account not found.' })
    }

    const following = me.following.some(id => id.toString() === target._id.toString())

    if (following) {
      me.following.pull(target._id)
      target.followers.pull(me._id)
    } else {
      me.following.addToSet(target._id)
      target.followers.addToSet(me._id)
    }

    await Promise.all([me.save(), target.save()])

    res.json({
      following: !following,
      followers: target.followers.length,
      followingCount: me.following.length
    })
  } catch (err) {
    console.error('FOLLOW:', err.message)
    res.status(500).json({ message: 'Could not update follow.' })
  }
})

// Feed: registered users' posts are returned, newest first
app.get('/api/posts', async (req, res) => {
  try {
    const posts = await Post.find({ archived: false }).sort({ createdAt: -1 })
    res.json(posts.map(formatPost))
  } catch (err) {
    console.error('GET posts:', err.message)
    res.status(500).json({ message: 'Could not load posts.' })
  }
})

// Create text post. Authenticated users own their posts.
app.post('/api/posts', auth, async (req, res) => {
  try {
    const user = await currentUser(req)
    if (!user) return res.status(401).json({ message: 'Account not found.' })

    const text = typeof req.body.text === 'string' ? req.body.text.trim() : ''
    if (!text) return res.status(400).json({ message: 'Enter a caption.' })
    if (text.length > 2200) return res.status(400).json({ message: 'Caption is too long.' })

    const post = await Post.create({
      username: user.username,
      owner: user._id,
      text
    })

    res.status(201).json(formatPost(post))
  } catch (err) {
    console.error('CREATE post:', err.message)
    res.status(500).json({ message: 'Could not create post.' })
  }
})

// Upload a photo or video post
app.post('/api/posts/media', auth, (req, res, next) => {
  upload.single('media')(req, res, err => {
    if (err) return res.status(400).json({ message: err.message || 'Upload failed.' })
    next()
  })
}, async (req, res) => {
  let savedFile

  try {
    const user = await currentUser(req)
    if (!user) return res.status(401).json({ message: 'Account not found.' })

    if (!req.file) {
      return res.status(400).json({ message: 'Select a photo or video first.' })
    }

    savedFile = req.file
    const text = typeof req.body.text === 'string' ? req.body.text.trim() : ''

    const post = await Post.create({
      username: user.username,
      owner: user._id,
      text,
      mediaUrl: `/uploads/${req.file.filename}`,
      mediaType: req.file.mimetype.startsWith('video/') ? 'video' : 'image'
    })

    res.status(201).json(formatPost(post))
  } catch (err) {
    console.error('MEDIA post:', err.message)
    if (savedFile) fs.unlink(savedFile.path, () => {})
    res.status(500).json({ message: 'Could not save media post.' })
  }
})

// Like or unlike a post
app.post('/api/posts/:id/like', auth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid post ID.' })
    }

    const post = await Post.findById(req.params.id)
    if (!post || post.archived) return res.status(404).json({ message: 'Post not found.' })

    const user = await currentUser(req)
    if (!user) return res.status(401).json({ message: 'Account not found.' })

    const alreadyLiked = post.likedByIds.some(id => id.toString() === user._id.toString())

    if (alreadyLiked) {
      post.likedByIds.pull(user._id)
    } else {
      post.likedByIds.addToSet(user._id)
    }

    post.likes = post.likedByIds.length
    post.likedBy = post.likedByIds.map(id => id.toString())

    await post.save()
    res.json(formatPost(post))
  } catch (err) {
    console.error('LIKE post:', err.message)
    res.status(500).json({ message: 'Could not update like.' })
  }
})

// Add comment
app.post('/api/posts/:id/comments', auth, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id)
    if (!post || post.archived) return res.status(404).json({ message: 'Post not found.' })

    const user = await currentUser(req)
    const text = typeof req.body.text === 'string' ? req.body.text.trim() : ''

    if (!user) return res.status(401).json({ message: 'Account not found.' })
    if (!text) return res.status(400).json({ message: 'Comment cannot be empty.' })
    if (text.length > 500) return res.status(400).json({ message: 'Comment is too long.' })

    post.comments.push({ user: user.username, userId: user._id, text })
    await post.save()

    res.status(201).json(formatPost(post))
  } catch (err) {
    console.error('COMMENT post:', err.message)
    res.status(500).json({ message: 'Could not save comment.' })
  }
})

// Delete your own comment
app.delete('/api/posts/:id/comments/:commentId', auth, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id)
    if (!post) return res.status(404).json({ message: 'Post not found.' })

    const comment = post.comments.id(req.params.commentId)
    if (!comment) return res.status(404).json({ message: 'Comment not found.' })

    if (!comment.userId || comment.userId.toString() !== req.userId) {
      return res.status(403).json({ message: 'You can delete only your own comments.' })
    }

    comment.deleteOne()
    await post.save()
    res.json(formatPost(post))
  } catch (err) {
    console.error('DELETE comment:', err.message)
    res.status(500).json({ message: 'Could not delete comment.' })
  }
})

// Edit your caption
app.patch('/api/posts/:id', auth, async (req, res) => {
  try {
    const post = await ownedPost(req, res)
    if (!post) return

    if (typeof req.body.text !== 'string') {
      return res.status(400).json({ message: 'Caption is required.' })
    }

    const text = req.body.text.trim()
    if (text.length > 2200) {
      return res.status(400).json({ message: 'Caption must be 2200 characters or fewer.' })
    }

    post.text = text
    await post.save()
    res.json(formatPost(post))
  } catch (err) {
    console.error('EDIT post:', err.message)
    res.status(500).json({ message: 'Could not edit post.' })
  }
})

// Delete your post
app.delete('/api/posts/:id', auth, async (req, res) => {
  try {
    const post = await ownedPost(req, res)
    if (!post) return

    if (post.mediaUrl) {
      const filename = path.basename(post.mediaUrl)
      fs.unlink(path.join(uploadDir, filename), () => {})
    }

    await post.deleteOne()
    res.json({ message: 'Post deleted.' })
  } catch (err) {
    console.error('DELETE post:', err.message)
    res.status(500).json({ message: 'Could not delete post.' })
  }
})

// Archive or restore your post
app.patch('/api/posts/:id/archive', auth, async (req, res) => {
  try {
    const post = await ownedPost(req, res)
    if (!post) return

    post.archived = Boolean(req.body.archived)
    await post.save()
    res.json(formatPost(post))
  } catch (err) {
    console.error('ARCHIVE post:', err.message)
    res.status(500).json({ message: 'Could not update archive.' })
  }
})

// Create a story (photo or video)
app.post('/api/stories', auth, (req, res, next) => {
  upload.single('media')(req, res, err => {
    if (err) return res.status(400).json({ message: err.message || 'Story upload failed.' })
    next()
  })
}, async (req, res) => {
  let savedFile

  try {
    const user = await currentUser(req)
    if (!user) return res.status(401).json({ message: 'Account not found.' })
    if (!req.file) return res.status(400).json({ message: 'Choose a story photo or video.' })

    savedFile = req.file

    const story = await Story.create({
      owner: user._id,
      username: user.username,
      mediaUrl: `/uploads/${req.file.filename}`,
      mediaType: req.file.mimetype.startsWith('video/') ? 'video' : 'image'
    })

    res.status(201).json(formatStory(story))
  } catch (err) {
    console.error('CREATE story:', err.message)
    if (savedFile) fs.unlink(savedFile.path, () => {})
    res.status(500).json({ message: 'Could not create story.' })
  }
})

// Active stories from all accounts
app.get('/api/stories', async (req, res) => {
  try {
    const stories = await Story.find({ expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 })
    res.json(stories.map(formatStory))
  } catch (err) {
    console.error('GET stories:', err.message)
    res.status(500).json({ message: 'Could not load stories.' })
  }
})

// Mark a story as viewed; count is based on unique logged-in accounts
app.post('/api/stories/:id/view', auth, async (req, res) => {
  try {
    const story = await Story.findById(req.params.id)
    if (!story || story.expiresAt <= new Date()) {
      return res.status(404).json({ message: 'Story not found or expired.' })
    }

    if (story.owner.toString() !== req.userId) {
      story.viewers.addToSet(new mongoose.Types.ObjectId(req.userId))
      await story.save()
    }

    res.json({
      id: story._id,
      viewCount: story.viewers.length,
      viewers: story.viewers.map(id => id.toString())
    })
  } catch (err) {
    console.error('VIEW story:', err.message)
    res.status(500).json({ message: 'Could not record story view.' })
  }
})

// Create a highlight from your own story IDs
app.post('/api/highlights', auth, async (req, res) => {
  try {
    const title = typeof req.body.title === 'string' ? req.body.title.trim() : ''
    const ids = Array.isArray(req.body.storyIds) ? req.body.storyIds : []

    if (!title || title.length > 40) {
      return res.status(400).json({ message: 'Highlight title must be 1–40 characters.' })
    }

    const stories = await Story.find({
      _id: { $in: ids },
      owner: req.userId
    })

    if (!stories.length) {
      return res.status(400).json({ message: 'Choose at least one of your own stories.' })
    }

    const highlight = await Highlight.create({
      owner: req.userId,
      title,
      stories: stories.map(story => story._id),
      coverUrl: stories[0].mediaUrl
    })

    res.status(201).json({
      id: highlight._id,
      title: highlight.title,
      coverUrl: highlight.coverUrl,
      storyIds: highlight.stories.map(id => id.toString())
    })
  } catch (err) {
    console.error('CREATE highlight:', err.message)
    res.status(500).json({ message: 'Could not create highlight.' })
  }
})

// View highlights on a user's profile
app.get('/api/users/:username/highlights', async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username })
    if (!user) return res.status(404).json({ message: 'User not found.' })

    const highlights = await Highlight.find({ owner: user._id }).sort({ createdAt: -1 })

    res.json(highlights.map(highlight => ({
      id: highlight._id,
      title: highlight.title,
      coverUrl: highlight.coverUrl,
      storyIds: highlight.stories.map(id => id.toString())
    })))
  } catch (err) {
    console.error('GET highlights:', err.message)
    res.status(500).json({ message: 'Could not load highlights.' })
  }
})

app.use('/api', (req, res) => {
  res.status(404).json({ message: `API route not found: ${req.method} ${req.originalUrl}` })
})

app.use((err, req, res, next) => {
  console.error('Server error:', err.message)
  if (res.headersSent) return next(err)
  res.status(500).json({ message: 'Server error. Check backend terminal.' })
})

async function startServer() {
  try {
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI is missing from backend/.env')
    if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is missing from backend/.env')

    await mongoose.connect(process.env.MONGO_URI)
    console.log('MongoDB connected successfully!')

    app.listen(PORT, () => {
      console.log(`Server running at http://localhost:${PORT}`)
    })
  } catch (err) {
    console.error('Startup failed:', err.message)
    process.exit(1)
  }
}

startServer()
