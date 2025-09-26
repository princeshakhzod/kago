const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const session = require('express-session');

// --- fetch fallback (Node < 18 bo‘lsa) ---
let __fetch = global.fetch;
if (!__fetch) {
  __fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
}
const fetch = (...args) => __fetch(...args);
// --- /fetch fallback ---

const app = express();
const PORT = process.env.PORT || 3000;

// -----------------------------------------------------------------------------
// Timezone Helpers
//
// The application is deployed on a server that may not be running in the
// Asia/Tashkent timezone. To ensure that all timestamps reflect the local
// Tashkent time rather than the server’s timezone, we define a pair of helper
// functions. `getTashkentTime` takes an optional Date (or ISO string) and
// converts it into a Date object representing the same moment in the
// Asia/Tashkent timezone. `formatTashkentTime` returns a human‑readable
// representation of a Date in the “HH:MM | DD.MM.YYYY” format, which is the
// preferred display format for the Telegram bot. These helpers rely on
// Node.js’s built‑in internationalization API (`Intl.DateTimeFormat`) which
// supports timezone conversions without requiring any external dependencies.

/**
 * Convert a Date or date string to a Date object in the Asia/Tashkent timezone.
 *
 * @param {Date|string} dateInput A Date instance or an ISO date string.
 * @returns {Date} A Date object representing the same moment in Asia/Tashkent.
 */
const getTashkentTime = (dateInput = new Date()) => {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  // Create a locale string for the Asia/Tashkent timezone. The resulting
  // string is interpreted in the server’s local timezone when passed back
  // into the Date constructor, effectively yielding a Date object that
  // represents the target moment in Asia/Tashkent.
  const tzString = date.toLocaleString('en-US', { timeZone: 'Asia/Tashkent' });
  return new Date(tzString);
};

/**
 * Format a Date or date string into "HH:MM | DD.MM.YYYY" using Tashkent time.
 *
 * @param {Date|string} dateInput A Date instance or an ISO date string.
 * @returns {string} The formatted time string.
 */
const formatTashkentTime = (dateInput = new Date()) => {
  const tzDate = getTashkentTime(dateInput);
  const hours = String(tzDate.getHours()).padStart(2, '0');
  const minutes = String(tzDate.getMinutes()).padStart(2, '0');
  const day = String(tzDate.getDate()).padStart(2, '0');
  const month = String(tzDate.getMonth() + 1).padStart(2, '0');
  const year = tzDate.getFullYear();
  return `${hours}:${minutes} | ${day}.${month}.${year}`;
};

// FastAPI Configuration
// The endpoint and auth token may be supplied via environment variables.  If not
// set, sensible defaults are used.  This allows the Node server to be
// configured without changing source code when deployed.
const FASTAPI_ENDPOINT = 'http://127.0.0.1:8001/api/orders';
const FASTAPI_AUTH_TOKEN = 'supersecret';

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'public/images');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ storage: storage });

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/public', express.static(path.join(__dirname, 'public')));

// Initialize JSON files if they don't exist
const initFile = (filePath, defaultValue = []) => {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultValue));
  }
};

initFile('restaurants.json');
initFile('dishes.json');
initFile('containers.json');
initFile('promocodes.json');
initFile('orders.json');
initFile('credentials.json', [{ id: 1, login: 'admin', password: 'admin123' }]);
// Initialize work hours with default schedule if not present
// Default schedule: every day from 08:00 to 23:00
const defaultWorkHours = {
  monday: { start: '08:00', end: '23:00' },
  tuesday: { start: '08:00', end: '23:00' },
  wednesday: { start: '08:00', end: '23:00' },
  thursday: { start: '08:00', end: '23:00' },
  friday: { start: '08:00', end: '23:00' },
  saturday: { start: '08:00', end: '23:00' },
  sunday: { start: '08:00', end: '23:00' }
};
initFile('workhours.json', defaultWorkHours);
// Initialize per‑branch opening hours storage.  This file stores a mapping
// of restaurant IDs to simple start/end times (e.g. { "1": { start:
// "08:00", end: "23:00" } }).  When absent a branch is considered
// always open.  Unlike work hours this schedule does not vary by day
// of week and instead applies uniformly every day.  Administrators
// manage these times through the admin panel.
initFile('branchtimes.json', {});

// Initialize additional data files for categories, branch types, and slides if they don't exist.
// Categories represent food categories (e.g., fast food, drinks) that dishes belong to.
// Branch types represent types of branches (e.g., restaurants, shops) that restaurants belong to.
// Slides represent promotional images shown on the homepage with an optional expiration date.
initFile('categories.json');
initFile('branchtypes.json');
initFile('slides.json');

// Initialise cashback storage. This JSON file stores a mapping of phone numbers to
// their available cashback balances (in UZS). If the file does not exist it
// will be created with an empty object. Both the Node server and the
// Telegram bot can read and modify this file to award or redeem cashback.
initFile('cashbacks.json', {});

/*
 * Cashback helpers
 *
 * The original implementation stored only a numeric value per phone number in
 * cashbacks.json. The new specification requires that each customer have a
 * unique six‑digit promo code associated with their cashback account. To
 * support this without breaking existing data, we normalise the structure so
 * that each entry is an object of the form { balance: number, promo: string }.
 * Old numeric values are automatically converted on first access. The helper
 * functions below centralise this logic.
 */

/**
 * Normalise the raw cashbacks object so each phone maps to an object with
 * `balance` and optional `promo` fields. Older numeric values are converted
 * into an object with only a balance. This helper does not write back to
 * disk; callers must persist any changes themselves.
 *
 * @param {object} raw The raw data read from cashbacks.json
 * @returns {object} A normalised object mapping phone -> { balance, promo }
 */
function normaliseCashbacks(raw) {
  const out = {};
  Object.keys(raw || {}).forEach(phone => {
    const val = raw[phone];
    if (typeof val === 'number') {
      out[phone] = { balance: val };
    } else if (val && typeof val === 'object') {
      const balance = typeof val.balance === 'number'
        ? val.balance
        : (typeof val.cashback === 'number' ? val.cashback : 0);
      const promo = typeof val.promo === 'string' ? val.promo
        : (typeof val.code === 'string' ? val.code : undefined);
      out[phone] = { balance, promo };
    }
  });
  return out;
}

/**
 * Generate a unique six‑digit promo code. Collisions are extremely unlikely
 * but we guard against them by checking against an existing set of codes.
 *
 * @param {Set<string>} existing A set of promo codes already in use
 * @returns {string} A new six‑digit code
 */
function generatePromoCode(existing = new Set()) {
  // Generate a six‑character alphanumeric promo code.  Codes consist of
  // uppercase letters and digits, e.g. "A23BU7".  If a generated code
  // already exists in the provided set, regeneration occurs until a
  // unique one is produced.  The length of six characters provides
  // over 2 billion possible combinations, greatly reducing the chance
  // of collisions compared to the previous six‑digit numeric scheme.
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (existing.has(code));
  return code;
}

/**
 * Persist the cashbacks data back to disk. Formats the JSON with
 * indentation for easier reading.
 *
 * @param {object} data The cashbacks data to write
 */
function saveCashbacks(data) {
  writeData('cashbacks.json', data);
}

/**
 * Delete an image file if it exists.  Many resources (dishes, restaurants,
 * categories, branch types, slides) store an `image` property pointing
 * into the `public/images` directory.  When a resource is updated or
 * deleted, the old image should be removed from disk to avoid leaving
 * orphaned files.  This helper normalises the path and attempts to
 * unlink the file without throwing if it is missing.
 *
 * @param {string|null|undefined} imagePath The image path from the JSON (e.g. "/public/images/abc.jpg")
 */
function removeImageFile(imagePath) {
  if (!imagePath) return;
  try {
    // Strip leading slash if present.  Join with __dirname so that
    // asynchronous unlinks will remove the correct file on this server.
    const relative = imagePath.startsWith('/') ? imagePath.slice(1) : imagePath;
    const full = path.join(__dirname, relative);
    fs.unlink(full, () => {});
  } catch (err) {
    // Ignore errors – the file may have already been removed or never existed.
  }
}

// Helper functions to read/write JSON files
const readData = (file) => {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};

const writeData = (file, data) => {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

// Authentication middleware
const checkAuth = (req, res, next) => {
  if (req.session.isAuthenticated) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
};

// FastAPI Notification Helper Function
const sendFastAPINotification = async (order) => {
  try {
    const restaurants = readData('restaurants.json');
    const dishes = readData('dishes.json');
    const containers = readData('containers.json');
    
    // Prepare the order data in a structured format
    const notificationData = {
      order_id: order.id,
      status: order.status,
      created_at: formatTashkentTime(order.createdAt),
      customer: {
        name: order.customer.name,
        phone: order.customer.phone,
        address: order.customer.address || 'Not specified',
        note: order.customer.note || '',
        location: order.customer.location || null
      },
      payment_method: order.paymentMethod === 'cash' ? 'cash' : 'card',
      items: [],
      totals: {
        dishes: 0,
        containers: 0,
        delivery: order.deliveryCost || 0,
        discount: order.discount || 0,
        final: 0
      }
    };

    // Process items
    order.items.forEach(item => {
      const dish = dishes.find(d => d.id === item.dishId);
      const restaurant = restaurants.find(r => r.id === item.restaurantId);
      const variantPrice = item.variant ? item.variant.price : item.price;
      const itemTotal = variantPrice * item.quantity;
      
      const itemData = {
        name: item.name,
        quantity: item.quantity,
        price_per_unit: variantPrice,
        total_price: itemTotal,
        restaurant: restaurant ? restaurant.name : 'Unknown',
        container: null
      };

      if (item.container) {
        const container = containers.find(c => c.id === item.container.id);
        // Tuzatish: faqat container quantity ga ko'paytirish, item quantity emas
        const containerTotal = item.container.price * (item.container.quantity || 1);
        
        itemData.container = {
          name: container ? container.name : 'Unknown',
          quantity: item.container.quantity || 1,
          price_per_unit: item.container.price,
          total_price: containerTotal
        };
        
        notificationData.totals.containers += containerTotal;
      }

      notificationData.items.push(itemData);
      notificationData.totals.dishes += itemTotal;
    });

    // Calculate final total
    notificationData.totals.final = 
      notificationData.totals.dishes + 
      notificationData.totals.containers + 
      notificationData.totals.delivery - 
      notificationData.totals.discount;

    // Send to FastAPI
    const response = await fetch(FASTAPI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${FASTAPI_AUTH_TOKEN}`
      },
      body: JSON.stringify(notificationData)
    });

    if (!response.ok) {
      console.error('Failed to send notification to FastAPI:', response.statusText);
    } else {
      console.log('Order notification successfully sent to FastAPI');
    }
  } catch (err) {
    console.error('Error sending notification to FastAPI:', err);
  }
};

// API Routes

// Auth routes
app.post('/api/login', (req, res) => {
  const { login, password } = req.body;
  const credentials = readData('credentials.json');
  
  const user = credentials.find(u => u.login === login && u.password === password);
  if (user) {
    req.session.isAuthenticated = true;
    req.session.userId = user.id;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/check-auth', (req, res) => {
  if (req.session.isAuthenticated) {
    res.json({ isAuthenticated: true });
  } else {
    res.json({ isAuthenticated: false });
  }
});

// Branch types routes
app.get('/api/branchtypes', (req, res) => {
  const branchTypes = readData('branchtypes.json');
  res.json(branchTypes);
});

app.post('/api/branchtypes', checkAuth, upload.single('image'), (req, res) => {
  const branchTypes = readData('branchtypes.json');
  const newType = {
    id: branchTypes.length > 0 ? Math.max(...branchTypes.map(t => t.id)) + 1 : 1,
    name: req.body.name,
    image: req.file ? `/public/images/${req.file.filename}` : null,
    active: req.body.active === 'true'
  };
  branchTypes.push(newType);
  writeData('branchtypes.json', branchTypes);
  res.json(newType);
});

app.put('/api/branchtypes/:id', checkAuth, upload.single('image'), (req, res) => {
  const branchTypes = readData('branchtypes.json');
  const index = branchTypes.findIndex(t => t.id === parseInt(req.params.id));
  if (index === -1) {
    return res.status(404).json({ error: 'Branch type not found' });
  }
  branchTypes[index].name = req.body.name;
  if (req.file) {
    branchTypes[index].image = `/public/images/${req.file.filename}`;
  }
  writeData('branchtypes.json', branchTypes);
  res.json(branchTypes[index]);
});

// Restaurants routes
app.get('/api/restaurants', (req, res) => {
  const restaurants = readData('restaurants.json');
  res.json(restaurants);
});

app.get('/api/restaurants/:id', (req, res) => {
  const restaurants = readData('restaurants.json');
  const restaurant = restaurants.find(r => r.id === parseInt(req.params.id));
  
  if (restaurant) {
    res.json(restaurant);
  } else {
    res.status(404).json({ error: 'Restaurant not found' });
  }
});

app.post('/api/restaurants', checkAuth, upload.single('image'), (req, res) => {
  const restaurants = readData('restaurants.json');
  const newRestaurant = {
    id: restaurants.length > 0 ? Math.max(...restaurants.map(r => r.id)) + 1 : 1,
    name: req.body.name,
    desc: req.body.desc,
    location: {
      lat: parseFloat(req.body.lat),
      lng: parseFloat(req.body.lng)
    },
    active: req.body.active === 'true',
    // Each restaurant can belong to a branch type. The frontend passes branchTypeId (or branch_type_id).
    branchTypeId: req.body.branchTypeId ? parseInt(req.body.branchTypeId) : (req.body.branch_type_id ? parseInt(req.body.branch_type_id) : null),
    image: req.file ? `/public/images/${req.file.filename}` : null,
    // Use server time (UTC) for persisted timestamp; convert to Tashkent only when displaying
    createdAt: new Date().toISOString()
  };
  
  restaurants.push(newRestaurant);
  writeData('restaurants.json', restaurants);
  res.json(newRestaurant);
});

app.put('/api/restaurants/:id', checkAuth, upload.single('image'), (req, res) => {
  const restaurants = readData('restaurants.json');
  const index = restaurants.findIndex(r => r.id === parseInt(req.params.id));
  
  if (index === -1) {
    return res.status(404).json({ error: 'Restaurant not found' });
  }
  
  const updatedRestaurant = {
    ...restaurants[index],
    name: req.body.name,
    desc: req.body.desc,
    location: {
      lat: parseFloat(req.body.lat),
      lng: parseFloat(req.body.lng)
    },
    active: req.body.active === 'true',
    branchTypeId: req.body.branchTypeId ? parseInt(req.body.branchTypeId) : (req.body.branch_type_id ? parseInt(req.body.branch_type_id) : restaurants[index].branchTypeId || null)
  };
  
  if (req.file) {
    // If uploading a new image remove the previous one
    removeImageFile(restaurants[index].image);
    updatedRestaurant.image = `/public/images/${req.file.filename}`;
  }
  
  restaurants[index] = updatedRestaurant;
  writeData('restaurants.json', restaurants);
  res.json(updatedRestaurant);
});

app.delete('/api/restaurants/:id', checkAuth, (req, res) => {
  let restaurants = readData('restaurants.json');
  const index = restaurants.findIndex(r => r.id === parseInt(req.params.id));
  
  if (index === -1) {
    return res.status(404).json({ error: 'Restaurant not found' });
  }
  
  const targetId = parseInt(req.params.id);
  const restaurant = restaurants.find(r => r.id === targetId);
  if (restaurant && restaurant.image) {
    removeImageFile(restaurant.image);
  }
  restaurants = restaurants.filter(r => r.id !== targetId);
  writeData('restaurants.json', restaurants);
  res.json({ success: true });
});

// Toggle restaurant active status
app.put('/api/restaurants/:id/active', checkAuth, (req, res) => {
  const restaurants = readData('restaurants.json');
  const index = restaurants.findIndex(r => r.id === parseInt(req.params.id));
  if (index === -1) {
    return res.status(404).json({ error: 'Restaurant not found' });
  }
  const current = restaurants[index].active !== undefined ? restaurants[index].active : true;
  const newStatus =
    req.body.active !== undefined ? req.body.active === true || req.body.active === 'true' : !current;
  restaurants[index].active = newStatus;
  writeData('restaurants.json', restaurants);
  res.json(restaurants[index]);
});

// Dishes routes
app.get('/api/dishes', (req, res) => {
  const dishes = readData('dishes.json');
  res.json(dishes);
});

app.get('/api/dishes/:id', (req, res) => {
  const dishes = readData('dishes.json');
  const dish = dishes.find(d => d.id === parseInt(req.params.id));
  
  if (dish) {
    res.json(dish);
  } else {
    res.status(404).json({ error: 'Dish not found' });
  }
});

app.post('/api/dishes', checkAuth, upload.single('image'), (req, res) => {
  const dishes = readData('dishes.json');
  const newDish = {
    id: dishes.length > 0 ? Math.max(...dishes.map(d => d.id)) + 1 : 1,
    name: req.body.name,
    desc: req.body.desc,
    price: parseFloat(req.body.price),
    restaurant_id: parseInt(req.body.restaurant_id),
    // Category association for this dish. Either category_id or categoryId may be provided.
    category_id: req.body.category_id ? parseInt(req.body.category_id) : (req.body.categoryId ? parseInt(req.body.categoryId) : null),
    containers: JSON.parse(req.body.containers),
    variants: JSON.parse(req.body.variants),
    image: req.file ? `/public/images/${req.file.filename}` : null,
    // Use server time (UTC) for persisted timestamp; convert to Tashkent only when displaying
    createdAt: new Date().toISOString(),
    // Dishes are active by default
    active: true
  };
  
  dishes.push(newDish);
  writeData('dishes.json', dishes);
  res.json(newDish);
});

app.put('/api/dishes/:id', checkAuth, upload.single('image'), (req, res) => {
  const dishes = readData('dishes.json');
  const index = dishes.findIndex(d => d.id === parseInt(req.params.id));
  
  if (index === -1) {
    return res.status(404).json({ error: 'Dish not found' });
  }
  
  const updatedDish = {
    ...dishes[index],
    name: req.body.name,
    desc: req.body.desc,
    price: parseFloat(req.body.price),
    restaurant_id: parseInt(req.body.restaurant_id),
    category_id: req.body.category_id ? parseInt(req.body.category_id) : (req.body.categoryId ? parseInt(req.body.categoryId) : dishes[index].category_id || null),
    containers: JSON.parse(req.body.containers),
    variants: JSON.parse(req.body.variants)
  };
  
  if (req.file) {
    // When a new image is uploaded remove the previous one to prevent
    // accumulation of unused files.  Only delete if the dish had an image.
    removeImageFile(dishes[index].image);
    updatedDish.image = `/public/images/${req.file.filename}`;
  }
  
  dishes[index] = updatedDish;
  writeData('dishes.json', dishes);
  res.json(updatedDish);
});

app.delete('/api/dishes/:id', checkAuth, (req, res) => {
  let dishes = readData('dishes.json');
  const index = dishes.findIndex(d => d.id === parseInt(req.params.id));
  
  if (index === -1) {
    return res.status(404).json({ error: 'Dish not found' });
  }
  
  // Before removing the dish record, clean up any associated images
  const targetId = parseInt(req.params.id);
  const targetDish = dishes.find(d => d.id === targetId);
  if (targetDish) {
    // Remove the main image
    removeImageFile(targetDish.image);
    // Remove variant images if they exist on each variant
    if (Array.isArray(targetDish.variants)) {
      for (const variant of targetDish.variants) {
        if (variant && variant.image) {
          removeImageFile(variant.image);
        }
      }
    }
  }
  dishes = dishes.filter(d => d.id !== targetId);
  writeData('dishes.json', dishes);
  res.json({ success: true });
});

// Toggle dish active status
app.put('/api/dishes/:id/active', checkAuth, (req, res) => {
  const dishes = readData('dishes.json');
  const index = dishes.findIndex(d => d.id === parseInt(req.params.id));
  if (index === -1) {
    return res.status(404).json({ error: 'Dish not found' });
  }
  const current = dishes[index].active !== undefined ? dishes[index].active : true;
  const newStatus =
    req.body.active !== undefined ? req.body.active === true || req.body.active === 'true' : !current;
  dishes[index].active = newStatus;
  writeData('dishes.json', dishes);
  res.json(dishes[index]);
});

// Containers routes
app.get('/api/containers', (req, res) => {
  const containers = readData('containers.json');
  res.json(containers);
});

app.get('/api/containers/:id', (req, res) => {
  const containers = readData('containers.json');
  const container = containers.find(c => c.id === parseInt(req.params.id));
  
  if (container) {
    res.json(container);
  } else {
    res.status(404).json({ error: 'Container not found' });
  }
});

app.post('/api/containers', checkAuth, (req, res) => {
  const containers = readData('containers.json');
  const newContainer = {
    id: containers.length > 0 ? Math.max(...containers.map(c => c.id)) + 1 : 1,
    name: req.body.name,
    price: parseFloat(req.body.price),
    // Use server time (UTC) for persisted timestamp; convert to Tashkent only when displaying
    createdAt: new Date().toISOString(),
    // Containers are active by default
    active: true
  };
  
  containers.push(newContainer);
  writeData('containers.json', containers);
  res.json(newContainer);
});

app.put('/api/containers/:id', checkAuth, (req, res) => {
  const containers = readData('containers.json');
  const index = containers.findIndex(c => c.id === parseInt(req.params.id));
  
  if (index === -1) {
    return res.status(404).json({ error: 'Container not found' });
  }
  
  const updatedContainer = {
    ...containers[index],
    name: req.body.name,
    price: parseFloat(req.body.price),
    // Preserve active status unless specifically toggled via separate endpoint
    active: containers[index].active !== undefined ? containers[index].active : true
  };
  
  containers[index] = updatedContainer;
  writeData('containers.json', containers);
  res.json(updatedContainer);
});

app.delete('/api/containers/:id', checkAuth, (req, res) => {
  let containers = readData('containers.json');
  const index = containers.findIndex(c => c.id === parseInt(req.params.id));
  
  if (index === -1) {
    return res.status(404).json({ error: 'Container not found' });
  }
  
  containers = containers.filter(c => c.id !== parseInt(req.params.id));
  writeData('containers.json', containers);
  res.json({ success: true });
});

// Toggle container active status
app.put('/api/containers/:id/active', checkAuth, (req, res) => {
  const containers = readData('containers.json');
  const index = containers.findIndex(c => c.id === parseInt(req.params.id));
  if (index === -1) {
    return res.status(404).json({ error: 'Container not found' });
  }
  // If active field is provided, use it; otherwise toggle
  const current = containers[index].active !== undefined ? containers[index].active : true;
  const newStatus =
    req.body.active !== undefined ? req.body.active === true || req.body.active === 'true' : !current;
  containers[index].active = newStatus;
  writeData('containers.json', containers);
  res.json(containers[index]);
});

// ==================== Categories Routes ====================
// Categories are used to group dishes (e.g., Fast Food, Drinks). Each category may have an
// optional image (square aspect). Admins can create, edit, delete categories. Categories
// have an `active` flag so they can be shown/hidden without deletion.

// Get all categories (public)
app.get('/api/categories', (req, res) => {
  const categories = readData('categories.json');
  res.json(categories);
});

// Get single category (public)
app.get('/api/categories/:id', (req, res) => {
  const categories = readData('categories.json');
  const category = categories.find(c => c.id === parseInt(req.params.id));
  if (category) {
    res.json(category);
  } else {
    res.status(404).json({ error: 'Category not found' });
  }
});

// Create a new category (admin only). Accepts multipart/form-data with fields:
// name: string, active: boolean (optional, defaults true), image: file (optional)
app.post('/api/categories', checkAuth, upload.single('image'), (req, res) => {
  const categories = readData('categories.json');
  const newCategory = {
    id: categories.length > 0 ? Math.max(...categories.map(c => c.id)) + 1 : 1,
    name: req.body.name,
    // default to active unless explicitly set to false
    active: req.body.active !== undefined ? req.body.active === 'true' || req.body.active === true : true,
    image: req.file ? `/public/images/${req.file.filename}` : null
  };
  categories.push(newCategory);
  writeData('categories.json', categories);
  res.json(newCategory);
});

// Update an existing category (admin only). Allows changing name, active status, and image.
app.put('/api/categories/:id', checkAuth, upload.single('image'), (req, res) => {
  const categories = readData('categories.json');
  const index = categories.findIndex(c => c.id === parseInt(req.params.id));
  if (index === -1) {
    return res.status(404).json({ error: 'Category not found' });
  }
  const updatedCategory = {
    ...categories[index],
    name: req.body.name,
    active: req.body.active !== undefined ? req.body.active === 'true' || req.body.active === true : categories[index].active
  };
  if (req.file) {
    // Remove previous image when a new one is uploaded
    removeImageFile(categories[index].image);
    updatedCategory.image = `/public/images/${req.file.filename}`;
  }
  categories[index] = updatedCategory;
  writeData('categories.json', categories);
  res.json(updatedCategory);
});

// Delete a category (admin only). Removing a category does not automatically remove dishes
// associated with it. Dishes may still reference a deleted category; the client should handle
// such cases gracefully (e.g., showing “Unknown”).
app.delete('/api/categories/:id', checkAuth, (req, res) => {
  let categories = readData('categories.json');
  const index = categories.findIndex(c => c.id === parseInt(req.params.id));
  if (index === -1) {
    return res.status(404).json({ error: 'Category not found' });
  }
  const targetId = parseInt(req.params.id);
  const category = categories.find(c => c.id === targetId);
  if (category && category.image) {
    removeImageFile(category.image);
  }
  categories = categories.filter(c => c.id !== targetId);
  writeData('categories.json', categories);
  res.json({ success: true });
});

// Toggle category active status (admin only). If no `active` boolean is provided in the
// request body then the status will be toggled. Otherwise the provided value is used.
app.put('/api/categories/:id/active', checkAuth, (req, res) => {
  const categories = readData('categories.json');
  const index = categories.findIndex(c => c.id === parseInt(req.params.id));
  if (index === -1) {
    return res.status(404).json({ error: 'Category not found' });
  }
  const current = categories[index].active !== undefined ? categories[index].active : true;
  const newStatus = req.body.active !== undefined ? req.body.active === 'true' || req.body.active === true : !current;
  categories[index].active = newStatus;
  writeData('categories.json', categories);
  res.json(categories[index]);
});

// ==================== Branch Types Routes ====================
// Branch types classify restaurants into high‑level categories (e.g., Restaurants, Shops).

// Get all branch types (public)
app.get('/api/branchtypes', (req, res) => {
  const branchTypes = readData('branchtypes.json');
  res.json(branchTypes);
});

// Get single branch type (public)
app.get('/api/branchtypes/:id', (req, res) => {
  const branchTypes = readData('branchtypes.json');
  const type = branchTypes.find(t => t.id === parseInt(req.params.id));
  if (type) {
    res.json(type);
  } else {
    res.status(404).json({ error: 'Branch type not found' });
  }
});

// Create branch type (admin only)
app.post('/api/branchtypes', checkAuth, upload.single('image'), (req, res) => {
  const branchTypes = readData('branchtypes.json');
  const newType = {
    id: branchTypes.length > 0 ? Math.max(...branchTypes.map(t => t.id)) + 1 : 1,
    name: req.body.name,
    active: req.body.active !== undefined ? req.body.active === 'true' || req.body.active === true : true,
    image: req.file ? `/public/images/${req.file.filename}` : null
  };
  branchTypes.push(newType);
  writeData('branchtypes.json', branchTypes);
  res.json(newType);
});

// Update branch type (admin only)
app.put('/api/branchtypes/:id', checkAuth, upload.single('image'), (req, res) => {
  const branchTypes = readData('branchtypes.json');
  const index = branchTypes.findIndex(t => t.id === parseInt(req.params.id));
  if (index === -1) {
    return res.status(404).json({ error: 'Branch type not found' });
  }
  const updated = {
    ...branchTypes[index],
    name: req.body.name,
    active: req.body.active !== undefined ? req.body.active === 'true' || req.body.active === true : branchTypes[index].active
  };
  if (req.file) {
    // Remove existing image if present when a new file is uploaded
    removeImageFile(branchTypes[index].image);
    updated.image = `/public/images/${req.file.filename}`;
  }
  branchTypes[index] = updated;
  writeData('branchtypes.json', branchTypes);
  res.json(updated);
});

// Delete branch type (admin only)
app.delete('/api/branchtypes/:id', checkAuth, (req, res) => {
  let branchTypes = readData('branchtypes.json');
  const index = branchTypes.findIndex(t => t.id === parseInt(req.params.id));
  if (index === -1) {
    return res.status(404).json({ error: 'Branch type not found' });
  }
  const targetId = parseInt(req.params.id);
  const branchType = branchTypes.find(t => t.id === targetId);
  if (branchType && branchType.image) {
    removeImageFile(branchType.image);
  }
  branchTypes = branchTypes.filter(t => t.id !== targetId);
  writeData('branchtypes.json', branchTypes);
  res.json({ success: true });
});

// Toggle branch type active status (admin only)
app.put('/api/branchtypes/:id/active', checkAuth, (req, res) => {
  const branchTypes = readData('branchtypes.json');
  const index = branchTypes.findIndex(t => t.id === parseInt(req.params.id));
  if (index === -1) {
    return res.status(404).json({ error: 'Branch type not found' });
  }
  const current = branchTypes[index].active !== undefined ? branchTypes[index].active : true;
  const newStatus = req.body.active !== undefined ? req.body.active === 'true' || req.body.active === true : !current;
  branchTypes[index].active = newStatus;
  writeData('branchtypes.json', branchTypes);
  res.json(branchTypes[index]);
});

// ==================== Slides Routes ====================
// Slides represent full‑width images that appear at the top of the homepage. Each slide
// has an optional expiration date/time (`expireAt`) expressed as an ISO string. The
// frontend is responsible for filtering out expired slides.

// Get all slides (public)
app.get('/api/slides', (req, res) => {
  let slides = readData('slides.json');
  const now = new Date();
  const activeSlides = [];
  let removed = false;
  for (const s of slides) {
    // If a slide has an expiration time and it is in the past, remove it and its image
    if (s.expireAt && new Date(s.expireAt) < now) {
      if (s.image) {
        removeImageFile(s.image);
      }
      removed = true;
    } else {
      activeSlides.push(s);
    }
  }
  if (removed) {
    writeData('slides.json', activeSlides);
  }
  res.json(activeSlides);
});

// Get a single slide (public)
app.get('/api/slides/:id', (req, res) => {
  const slides = readData('slides.json');
  const slide = slides.find(s => s.id === parseInt(req.params.id));
  if (slide) {
    res.json(slide);
  } else {
    res.status(404).json({ error: 'Slide not found' });
  }
});

// Create a slide (admin only). Accepts multipart/form-data with fields:
// image (file), expireAt (ISO date string, optional)
app.post('/api/slides', checkAuth, upload.single('image'), (req, res) => {
  const slides = readData('slides.json');
  const newSlide = {
    id: slides.length > 0 ? Math.max(...slides.map(s => s.id)) + 1 : 1,
    image: req.file ? `/public/images/${req.file.filename}` : null,
    // expireAt may be undefined or empty string if not provided
    expireAt: req.body.expireAt && req.body.expireAt !== '' ? new Date(req.body.expireAt).toISOString() : null
  };
  slides.push(newSlide);
  writeData('slides.json', slides);
  res.json(newSlide);
});

// Update a slide (admin only)
app.put('/api/slides/:id', checkAuth, upload.single('image'), (req, res) => {
  const slides = readData('slides.json');
  const index = slides.findIndex(s => s.id === parseInt(req.params.id));
  if (index === -1) {
    return res.status(404).json({ error: 'Slide not found' });
  }
  const updated = { ...slides[index] };
  if (req.file) {
    // Remove previous image for this slide before updating
    removeImageFile(slides[index].image);
    updated.image = `/public/images/${req.file.filename}`;
  }
  if (req.body.expireAt !== undefined) {
    updated.expireAt = req.body.expireAt && req.body.expireAt !== '' ? new Date(req.body.expireAt).toISOString() : null;
  }
  slides[index] = updated;
  writeData('slides.json', slides);
  res.json(updated);
});

// Delete a slide (admin only)
app.delete('/api/slides/:id', checkAuth, (req, res) => {
  let slides = readData('slides.json');
  const index = slides.findIndex(s => s.id === parseInt(req.params.id));
  if (index === -1) {
    return res.status(404).json({ error: 'Slide not found' });
  }
  const targetId = parseInt(req.params.id);
  const slide = slides.find(s => s.id === targetId);
  if (slide && slide.image) {
    removeImageFile(slide.image);
  }
  slides = slides.filter(s => s.id !== targetId);
  writeData('slides.json', slides);
  res.json({ success: true });
});

// Promocodes routes
app.get('/api/promocodes', (req, res) => {
  const promocodes = readData('promocodes.json');
  res.json(promocodes);
});

app.post('/api/promocodes', checkAuth, (req, res) => {
  const promocodes = readData('promocodes.json');
  const newPromocode = {
    code: req.body.code,
    min_sum: parseFloat(req.body.min_sum),
    discount: parseFloat(req.body.discount),
    // Use server time (UTC) for persisted timestamp; convert to Tashkent only when displaying
    createdAt: new Date().toISOString()
  };
  
  promocodes.push(newPromocode);
  writeData('promocodes.json', promocodes);
  res.json(newPromocode);
});

app.delete('/api/promocodes/:code', checkAuth, (req, res) => {
  let promocodes = readData('promocodes.json');
  promocodes = promocodes.filter(p => p.code !== req.params.code);
  writeData('promocodes.json', promocodes);
  res.json({ success: true });
});

// Orders routes
app.get('/api/orders', checkAuth, (req, res) => {
  const orders = readData('orders.json');
  res.json(orders);
});

app.post('/api/orders', (req, res) => {
  const orders = readData('orders.json');
  // Construct a richer order object.  Preserve the incoming customer and items,
  // attach payment and delivery details if provided, and timestamp the order.
  const newOrder = {
    id: orders.length > 0 ? Math.max(...orders.map(o => o.id)) + 1 : 1,
    // Preserve the incoming customer object.  It may contain additional
    // fields (e.g. companyName, phone2, address) for business orders.
    customer: req.body.customer,
    items: req.body.items,
    status: 'pending',
    createdAt: new Date().toISOString(),
    paymentMethod: req.body.paymentMethod || 'cash',
    deliveryCost: req.body.deliveryCost || 0,
    discount: req.body.discount || 0,
    promoCode: req.body.promoCode || null,
    // Business flag indicates if this is a large volume order placed via biznes.html
    business: Boolean(req.body.business)
  };

  // -------------------------------------------------------------------------
  // Award cashback and promo code
  //
  // When a new order is placed we award 1% cashback on the food subtotal. Each
  // customer is identified by their phone number. If this is the first time
  // awarding cashback for the phone, a unique 6‑digit promo code is
  // generated and persisted. The order response includes the amount of
  // cashback just earned, the customer's new cashback balance and their promo
  // code so that the frontend can display this information. If no phone
  // number is provided the cashback logic is skipped.
  try {
    const phone = req.body.customer && req.body.customer.phone;
    if (phone) {
      // Compute 1% cashback on the subtotal of all dish variants (excluding
      // containers). We intentionally base this on the declared price and
      // quantity rather than relying on the totals field so the calculation
      // remains on the server side. If no items exist the cashback is zero.
      let itemsSubtotal = 0;
      if (Array.isArray(req.body.items)) {
        req.body.items.forEach(item => {
          const pricePer = typeof item.price === 'number' ? item.price
            : (item.variant && typeof item.variant.price === 'number' ? item.variant.price : 0);
          const qty = item.quantity || 1;
          itemsSubtotal += pricePer * qty;
        });
      }
      const earned = Math.floor(itemsSubtotal * 0.01);
      if (earned > 0) {
        const raw = readData('cashbacks.json');
        const cashbacks = normaliseCashbacks(raw);
        // Build a set of promo codes for uniqueness checking
        const existingCodes = new Set(Object.values(cashbacks).map(e => e.promo).filter(Boolean));
        let entry = cashbacks[phone] || { balance: 0 };
        let promo = entry.promo;
        if (!promo) {
          promo = generatePromoCode(existingCodes);
        }
        const newBalance = (entry.balance || 0) + earned;
        cashbacks[phone] = { balance: newBalance, promo };
        saveCashbacks(cashbacks);
        // Attach cashback information to the order for client display
        newOrder.cashbackAdded = earned;
        newOrder.cashbackBalance = newBalance;
        newOrder.promoCode = promo;
      }
    }
  } catch (err) {
    console.error('Failed to award cashback:', err);
  }

  orders.push(newOrder);
  writeData('orders.json', orders);

  // Asynchronously notify the FastAPI backend about this order.  This call is
  // fire‑and‑forget; any errors will be logged but will not affect the
  // response to the client.
  sendFastAPINotification(newOrder).catch((err) => {
    console.error('Failed to notify FastAPI for new order:', err);
  });

  res.json(newOrder);
});

// ----------------------------------------------------------------------------
// Cashback API
//
// GET /api/cashback/:phone
//   Returns the current cashback balance for the given phone number. If no
//   record exists, a balance of zero is returned. The phone number should
//   match exactly the string provided by the customer (no formatting is
//   applied).
app.get('/api/cashback/:phone', (req, res) => {
  const phone = req.params.phone;
  try {
    const raw = readData('cashbacks.json');
    const cashbacks = normaliseCashbacks(raw);
    const entry = cashbacks[phone];
    const balance = entry ? entry.balance : 0;
    res.json({ cashback: balance, promoCode: entry ? entry.promo : undefined });
  } catch (err) {
    res.status(500).json({ error: 'Unable to read cashback data' });
  }
});

// POST /api/cashback/apply
//   Deducts a specified cashback amount for a phone number. The request body
//   must include a `phone` field and an `amount` numeric field. The server
//   will deduct up to the provided amount (but never below zero) and return
//   the new balance. If the phone number does not exist, it will be created
//   with a zero balance before deduction.
app.post('/api/cashback/apply', (req, res) => {
  const { phone, amount } = req.body;
  if (!phone || typeof amount !== 'number') {
    return res.status(400).json({ error: 'Invalid parameters' });
  }
  try {
    const raw = readData('cashbacks.json');
    const cashbacks = normaliseCashbacks(raw);
    const entry = cashbacks[phone] || { balance: 0 };
    const current = entry.balance || 0;
    const deduction = Math.min(current, amount);
    entry.balance = current - deduction;
    cashbacks[phone] = entry;
    saveCashbacks(cashbacks);
    res.json({ cashback: entry.balance, promoCode: entry.promo });
  } catch (err) {
    res.status(500).json({ error: 'Unable to update cashback data' });
  }
});

// ---------------------------------------------------------------------------
// Promo code endpoints
//
// Each customer is assigned a unique six‑digit promo code when they first earn
// cashback. The following endpoints allow the frontend to validate and
// redeem promo codes independent of the raw phone number. These endpoints
// operate on the cashbacks.json file via the normalisation helpers above.

// GET /api/promocode/:code
//   Validate a promo code and return the associated phone and balance. If
//   the code does not exist the server returns a 404. Clients can use the
//   balance value to determine whether the minimum threshold (10,000 so‘m)
//   has been met.
app.get('/api/promocode/:code', (req, res) => {
  const code = req.params.code;
  try {
    const raw = readData('cashbacks.json');
    const cashbacks = normaliseCashbacks(raw);
    let foundPhone = null;
    let foundEntry = null;
    for (const [phone, entry] of Object.entries(cashbacks)) {
      if (entry && entry.promo && entry.promo.toString() === code.toString()) {
        foundPhone = phone;
        foundEntry = entry;
        break;
      }
    }
    if (!foundPhone || !foundEntry) {
      return res.status(404).json({ error: 'Promo code not found' });
    }
    return res.json({ phone: foundPhone, cashback: foundEntry.balance, promoCode: foundEntry.promo });
  } catch (err) {
    res.status(500).json({ error: 'Unable to read promo code data' });
  }
});

// POST /api/promocode/apply
//   Deduct a given amount of cashback for the phone associated with a promo
//   code. The request body must include a `code` field and a numeric
//   `amount` field. If the code is invalid a 404 is returned. The server
//   responds with the new balance and the associated phone number.
app.post('/api/promocode/apply', (req, res) => {
  const { code, amount } = req.body;
  if (!code || typeof amount !== 'number') {
    return res.status(400).json({ error: 'Invalid parameters' });
  }
  try {
    const raw = readData('cashbacks.json');
    const cashbacks = normaliseCashbacks(raw);
    let targetPhone = null;
    let entry = null;
    for (const [phone, e] of Object.entries(cashbacks)) {
      if (e && e.promo && e.promo.toString() === code.toString()) {
        targetPhone = phone;
        entry = e;
        break;
      }
    }
    if (!targetPhone || !entry) {
      return res.status(404).json({ error: 'Promo code not found' });
    }
    const current = entry.balance || 0;
    const deduction = Math.min(current, amount);
    entry.balance = current - deduction;
    cashbacks[targetPhone] = entry;
    saveCashbacks(cashbacks);
    res.json({ phone: targetPhone, cashback: entry.balance, promoCode: entry.promo });
  } catch (err) {
    res.status(500).json({ error: 'Unable to update promo code' });
  }
});

// ---------------------------------------------------------------------------
// User profile endpoint
//
// Exposes the currently authenticated credential (login/password/restaurantId)
// so the frontend can adjust the admin panel according to the user’s role.
// Returns a 401 if no session exists or the session is invalid.
app.get('/api/me', (req, res) => {
  if (!req.session.isAuthenticated || !req.session.userId) {
    return res.status(401).json({ error: 'Unauthenticated' });
  }
  try {
    const credentials = readData('credentials.json');
    const user = credentials.find(c => c.id === req.session.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    // Do not expose the password in the response
    const { password, ...sanitised } = user;
    res.json(sanitised);
  } catch (err) {
    res.status(500).json({ error: 'Unable to fetch user details' });
  }
});


// Stats routes
app.get('/api/stats/:period', checkAuth, (req, res) => {
  const orders = readData('orders.json');
  const restaurants = readData('restaurants.json');
  const dishes = readData('dishes.json');
  
  // Filter orders by period. We base all temporal calculations on the
  // Asia/Tashkent timezone to avoid discrepancies caused by the server’s
  // local timezone. `nowTz` represents the current moment in Tashkent.
  let filteredOrders = [];
  const nowTz = getTashkentTime();
  
  switch (req.params.period) {
    case 'today': {
      const todayStart = new Date(nowTz.getFullYear(), nowTz.getMonth(), nowTz.getDate());
      filteredOrders = orders.filter(o => {
        const orderTz = getTashkentTime(o.createdAt);
        return orderTz >= todayStart;
      });
      break;
    }
    case 'week': {
      const weekStart = new Date(nowTz.getFullYear(), nowTz.getMonth(), nowTz.getDate() - 7);
      filteredOrders = orders.filter(o => {
        const orderTz = getTashkentTime(o.createdAt);
        return orderTz >= weekStart;
      });
      break;
    }
    case 'month': {
      const monthStart = new Date(nowTz.getFullYear(), nowTz.getMonth(), nowTz.getDate() - 31);
      filteredOrders = orders.filter(o => {
        const orderTz = getTashkentTime(o.createdAt);
        return orderTz >= monthStart;
      });
      break;
    }
    default:
      filteredOrders = orders;
  }
  
  // Calculate revenue
  const revenue = filteredOrders.reduce((total, order) => {
    const orderTotal = order.items.reduce((sum, item) => 
      sum + (item.price * item.quantity), 0) + order.deliveryCost - (order.discount || 0);
    return total + orderTotal;
  }, 0);
  
  // Calculate restaurant stats
  const restaurantStats = restaurants.map(restaurant => {
    const restaurantOrders = filteredOrders.filter(o => 
      o.items.some(item => item.restaurantId === restaurant.id));
    
    const ordersCount = restaurantOrders.length;
    const restaurantRevenue = restaurantOrders.reduce((total, order) => {
      const orderItems = order.items.filter(item => item.restaurantId === restaurant.id);
      const itemsTotal = orderItems.reduce((sum, item) => 
        sum + (item.price * item.quantity), 0);
      
      // Distribute delivery cost proportionally
      const deliveryShare = orderItems.length / order.items.length;
      const deliveryTotal = order.deliveryCost * deliveryShare;
      
      return total + itemsTotal + deliveryTotal - (order.discount || 0) * deliveryShare;
    }, 0);
    
    return {
      restaurant_id: restaurant.id,
      orders_count: ordersCount,
      revenue: restaurantRevenue
    };
  }).filter(stat => stat.orders_count > 0);
  
  // Calculate top dishes
  const dishCounts = {};
  filteredOrders.forEach(order => {
    order.items.forEach(item => {
      if (!dishCounts[item.dishId]) {
        dishCounts[item.dishId] = 0;
      }
      dishCounts[item.dishId] += item.quantity;
    });
  });
  
  const topDishes = Object.entries(dishCounts)
    .map(([dishId, count]) => ({
      dish_id: parseInt(dishId),
      count: count
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  
  // Calculate top users
  const userOrders = {};
  filteredOrders.forEach(order => {
    if (!userOrders[order.customer.phone]) {
      userOrders[order.customer.phone] = {
        name: order.customer.name,
        phone: order.customer.phone,
        orders_count: 0
      };
    }
    userOrders[order.customer.phone].orders_count++;
  });
  
  const topUsers = Object.values(userOrders)
    .sort((a, b) => b.orders_count - a.orders_count)
    .slice(0, 5);
  
  res.json({
    revenue,
    restaurantStats,
    topDishes,
    topUsers
  });
});

// -------------------- Public statistics route --------------------
// Returns basic statistics accessible without authentication. This endpoint
// exposes only the number of orders per restaurant and the number of times
// each dish was ordered. The client can use this to display top branches
// and top dishes on the public homepage. The results are not time‑bound;
// they reflect all historical orders. No revenue or user data is returned
// for privacy reasons.
app.get('/api/public-stats', (req, res) => {
  try {
    const orders = readData('orders.json');
    const restaurants = readData('restaurants.json');
    const dishes = readData('dishes.json');
    // Count orders per restaurant
    const restaurantCounts = {};
    orders.forEach(order => {
      const uniqueRestaurantIds = new Set(order.items.map(item => item.restaurantId));
      uniqueRestaurantIds.forEach(rid => {
        if (!restaurantCounts[rid]) restaurantCounts[rid] = 0;
        restaurantCounts[rid] += 1;
      });
    });
    // Determine how many restaurants to include: 10% of all restaurants,
    // rounded up, but always at least three. If there are no restaurants
    // recorded this yields zero.
    const totalRestaurants = restaurants.length || 0;
    const maxCount = Math.max(3, Math.ceil(totalRestaurants * 0.10));

    // Build stats for all restaurants so that those with zero orders are
    // included. This ensures that when there are few or no orders the
    // popular branch section can still display at least three entries.
    const restaurantStats = restaurants.map(r => {
      const count = restaurantCounts[r.id] || 0;
      return { restaurant_id: r.id, orders_count: count };
    })
      .sort((a, b) => b.orders_count - a.orders_count)
      .slice(0, maxCount);
    // Count dish orders
    const dishCounts = {};
    orders.forEach(order => {
      order.items.forEach(item => {
        if (!dishCounts[item.dishId]) dishCounts[item.dishId] = 0;
        dishCounts[item.dishId] += item.quantity;
      });
    });
    const topDishes = Object.entries(dishCounts)
      .map(([did, count]) => ({ dish_id: parseInt(did), count: count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    res.json({ topRestaurants: restaurantStats, topDishes });
  } catch (err) {
    console.error('Failed to compute public stats:', err);
    res.status(500).json({ error: 'Failed to compute stats' });
  }
});

// Credentials routes
app.get('/api/credentials', checkAuth, (req, res) => {
  const credentials = readData('credentials.json');
  res.json(credentials);
});

app.get('/api/credentials/:id', checkAuth, (req, res) => {
  const credentials = readData('credentials.json');
  const credential = credentials.find(c => c.id === parseInt(req.params.id));
  
  if (credential) {
    res.json(credential);
  } else {
    res.status(404).json({ error: 'Credential not found' });
  }
});

app.post('/api/credentials', checkAuth, (req, res) => {
  const credentials = readData('credentials.json');
  const newCredential = {
    id: credentials.length > 0 ? Math.max(...credentials.map(c => c.id)) + 1 : 1,
    login: req.body.login,
    password: req.body.password,
    // Optional link to a specific restaurant. If provided the user will only
    // have access to that branch in the admin panel. A null or undefined
    // value denotes a full administrator.
    restaurantId: req.body.restaurantId ? parseInt(req.body.restaurantId) : null,
    // Use server time (UTC) for persisted timestamp; convert to Tashkent only when displaying
    createdAt: new Date().toISOString()
  };
  
  credentials.push(newCredential);
  writeData('credentials.json', credentials);
  res.json(newCredential);
});

app.put('/api/credentials/:id', checkAuth, (req, res) => {
  const credentials = readData('credentials.json');
  const index = credentials.findIndex(c => c.id === parseInt(req.params.id));
  
  if (index === -1) {
    return res.status(404).json({ error: 'Credential not found' });
  }
  
  const updatedCredential = {
    ...credentials[index],
    login: req.body.login,
    password: req.body.password,
    // When updating, allow changing the assigned restaurant. If the field is
    // omitted or empty, retain the current restaurantId. Passing an empty
    // string will clear the association.
    restaurantId: req.body.restaurantId !== undefined
      ? (req.body.restaurantId === '' ? null : parseInt(req.body.restaurantId))
      : credentials[index].restaurantId
  };
  
  credentials[index] = updatedCredential;
  writeData('credentials.json', credentials);
  res.json(updatedCredential);
});

app.delete('/api/credentials/:id', checkAuth, (req, res) => {
  let credentials = readData('credentials.json');
  const index = credentials.findIndex(c => c.id === parseInt(req.params.id));
  
  if (index === -1) {
    return res.status(404).json({ error: 'Credential not found' });
  }
  
  credentials = credentials.filter(c => c.id !== parseInt(req.params.id));
  writeData('credentials.json', credentials);
  res.json({ success: true });
});

// ==================== Work Hours Routes ====================
// Get work hours (public)
app.get('/api/workhours', (req, res) => {
  try {
    const workhours = readData('workhours.json');
    res.json(workhours);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read work hours' });
  }
});

// Update work hours (admin only)
app.put('/api/workhours', checkAuth, (req, res) => {
  try {
    const newHours = req.body;
    if (!newHours || typeof newHours !== 'object') {
      return res.status(400).json({ error: 'Invalid work hours data' });
    }
    writeData('workhours.json', newHours);
    res.json(newHours);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update work hours' });
  }
});

// ==================== Branch Times Routes ====================
// Return the full mapping of branch opening hours.  This endpoint is
// public so that the client can determine whether a restaurant is
// currently open based on the saved schedule.  If the file does not
// exist or cannot be read an error is returned.
app.get('/api/branchtimes', (req, res) => {
  try {
    const times = readData('branchtimes.json');
    res.json(times);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read branch times' });
  }
});

// Update the entire branch opening hours mapping.  The admin panel
// sends an object mapping restaurant IDs to { start, end } values.  No
// partial updates are supported – the full map should be sent on
// every update.  Only authenticated users may change these times.
app.put('/api/branchtimes', checkAuth, (req, res) => {
  try {
    const times = req.body;
    if (!times || typeof times !== 'object') {
      return res.status(400).json({ error: 'Invalid branch times data' });
    }
    writeData('branchtimes.json', times);
    res.json(times);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update branch times' });
  }
});

// KAGO AI uchun sodda endpoint: {message} qabul qiladi va matn qaytaradi
app.post('/api/agent', async (req, res) => {
  try {
    const input = (req.body && req.body.message || '').toString().trim();

    const restaurants = readData('restaurants.json');
    const dishes      = readData('dishes.json');
    const branchTimes = readData('branchtimes.json');
    const workhours   = readData('workhours.json');

    if (!input) {
      return res.status(400).json({ ok: false, error: 'message is required' });
    }

    // API kalit — ochiq kodda (env emas)
    const apiKey = "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";
    if (!apiKey) {
      return res.status(500).json({ ok: false, error: 'OpenAI API key is not configured on the server' });
    }

    const ctx = {
      restaurants: restaurants.map(r => ({ id: r.id, name: r.name, active: r.active })),
      dishes: dishes.filter(d => d.active !== false).slice(0, 200)
                    .map(d => ({ id: d.id, name: d.name, price: d.price, restaurant_id: d.restaurant_id })),
      branchTimes,
      workhours,
      deliveryRule: "0–3 km = 10 000 so‘m; har keyingi 1 km uchun +1 800 so‘m."
    };

    // Faqat KAGO mavzulariga javob berish tekshiruvi
    const lowered = input.toLowerCase();
    const siteKeywords = ['kago','sayt','narx','filial','filiallar','katalog','kategoriya','delivery','yetkazib','manzil','adres','keshbek','cashback','promo','promo kod','promokod','buyurtma','mahsulot','restoran','menu','ichimlik','taom','to\'lov','aksiyalar','promo-kod','olish','yuborish'];
    const matchesKeyword = siteKeywords.some(k => lowered.includes(k));
    if (!matchesKeyword) {
      const replyMsg = 'Kechirasiz, men faqat Kago sayti va uning xizmatlari haqida maʼlumot bera olaman. Kago bo‘yicha savol bering: filial, menyu, narx, yetkazib berish, keshbek, promo va h.k.';
      return res.json({ ok: true, reply: replyMsg });
    }

    const systemMsg = {
      role: "system",
      content:
        "Siz KAGO saytining AI yordamchisisiz. Faqat KAGO doirasida javob bering: filiallar, menyu, narxlar, yetkazib berish, ish vaqti, keshbek/promo. " +
        "Xushmuomala, qisqa va foydali bo‘ling; takroriy 'Kago agentman' deb boshlamang. " +
        "Yetkazib berish: 0–3 km = 10 000 so‘m; har qo‘shimcha km = +1 800 so‘m. " +
        "Foydalanuvchi aniq filial yoki taom so‘rasa, nomi va narxi bilan ko‘rsating. " +
        "KAGO bilan bog‘liq bo‘lmagan mavzularga muloyim rad eting va KAGO mavzusiga yo‘naltiring."
    };

    const messages = [
      systemMsg,
      { role: "system", name: "kago_context", content: JSON.stringify(ctx) },
      { role: "user", content: input }
    ];

    const https = require('https');
    const payload = JSON.stringify({ model: "gpt-4o", messages, temperature: 0.7, max_tokens: 500 });
    const options = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization': `Bearer ${apiKey}`
      }
    };
    const apiReq = https.request(options, apiRes => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const reply = parsed?.choices?.[0]?.message?.content || 'Kechirasiz, javobni yaratib bo‘lmadi.';
          return res.json({ ok: true, reply });
        } catch (e) {
          console.error('Parse error:', e);
          return res.status(500).json({ ok: false, error: 'Failed to parse response from OpenAI' });
        }
      });
    });
    apiReq.on('error', err => {
      console.error('OpenAI request error:', err);
      return res.status(500).json({ ok: false, error: 'Failed to communicate with OpenAI' });
    });
    apiReq.write(payload);
    apiReq.end();
  } catch (err) {
    console.error('Unexpected error in /api/agent:', err);
    return res.status(500).json({ ok: false, error: 'Unexpected server error' });
  }
});


// Serve HTML files
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

/**
 * OpenAI chat proxy
 *
 * This endpoint allows the frontend to forward a chat conversation to
 * OpenAI’s ChatGPT API without exposing the API key to the browser. The
 * client sends a JSON payload with a `messages` array conforming to the
 * OpenAI chat API format. The server then makes a request to OpenAI and
 * returns the response JSON. If the OpenAI API key is not configured
 * (via the OPENAI_API_KEY environment variable), an error is returned.
 */
app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid chat request: messages array is required' });
    }
    const apiKey = "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"; // API kalitingni bu yerga yoz
    if (!apiKey) {
      return res.status(500).json({ error: 'OpenAI API key is not configured on the server' });
    }
    const payload = JSON.stringify({
      model: "gpt-4o",
      messages
    });
    const https = require('https');
    const options = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization': `Bearer ${apiKey}`
      }
    };
    const apiReq = https.request(options, apiRes => {
      let data = '';
      apiRes.on('data', chunk => {
        data += chunk;
      });
      apiRes.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          res.json(parsed);
        } catch (err) {
          console.error('Error parsing OpenAI response:', err);
          res.status(500).json({ error: 'Failed to parse response from OpenAI' });
        }
      });
    });
    apiReq.on('error', err => {
      console.error('Error communicating with OpenAI:', err);
      res.status(500).json({ error: 'Failed to communicate with OpenAI' });
    });
    apiReq.write(payload);
    apiReq.end();
  } catch (err) {
    console.error('Unexpected error in /api/chat:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
