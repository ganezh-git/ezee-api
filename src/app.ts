import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { environment } from './config/environment';
import { errorHandler } from './middleware/error-handler';
import { authenticate, authorize } from './middleware/authenticate';
import authRoutes from './modules/auth/auth.routes';
import adminRoutes from './modules/admin/admin.routes';
import permitRoutes from './modules/permit/permit.routes';
import permitBirlaRoutes from './modules/permit-birla/permit-birla.routes';
import vehicleRoutes from './modules/vehicle/vehicle.routes';
import visitorRoutes from './modules/visitor/visitor.routes';
import libraryRoutes from './modules/library/library.routes';
import safetyRoutes from './modules/safety/safety.routes';

const app = express();

// Disable ETag to prevent 304 responses with stale cached data
app.set('etag', false);

// Trust proxy (required for Cloud Run / load balancers)
app.set('trust proxy', 1);

// Compression - reduces JSON payload sizes by 60-80%
app.use(compression());

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false,       // API returns JSON, not HTML — CSP not needed
  crossOriginResourcePolicy: false,   // Allow cross-origin requests from Angular dev server
  crossOriginOpenerPolicy: false,     // Allow cross-origin opener
}));
app.use(cors({
  origin: environment.cors.origin.split(',').map(s => s.trim()),
  credentials: true,
}));

// Rate limiting
app.use('/api/auth', rateLimit({
  windowMs: environment.rateLimit.windowMs,
  max: environment.rateLimit.max,
  message: { error: 'Too many requests, please try again later' },
}));

// Body parsing
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));

// Disable caching for API responses (prevent 304 stale data)
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  next();
});

// Request timeout - prevent requests from hanging forever
app.use((req, res, next) => {
  res.setTimeout(30000, () => {
    res.status(408).json({ error: 'Request timeout' });
  });
  next();
});

// Request logger (dev)
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`${req.method} ${req.url} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// Health check
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    environment: environment.nodeEnv,
    timestamp: new Date().toISOString(),
  });
});

// Public reference data (no auth required)
app.get('/api/reference/departments', (_req, res) => {
  res.json([
    'EHS', 'Electrical', 'Emulsion Block', 'HR', 'PEL Lab', 'Planning',
    'Plant Admin', 'Raw Material', 'Packing Material', 'Finished Goods',
    'Plant Engg', 'QA', 'Resin', 'Safety & Security', 'SPB Packing',
    'SPB Process', 'Technical Cell', 'TRACC', 'WPB Packing', 'WPB Process',
    'Security Office', 'IT', 'Mechanical', 'Production',
  ]);
});

app.get('/api/reference/designations', (_req, res) => {
  res.json([
    { id: 1, label: 'GWM' },
    { id: 2, label: 'Sr. Manager' },
    { id: 3, label: 'Manager' },
    { id: 4, label: 'Executive' },
    { id: 5, label: 'Engineer' },
    { id: 6, label: 'Sr Officer / Level II' },
    { id: 7, label: 'Officer' },
    { id: 8, label: 'Operator' },
    { id: 9, label: 'Security' },
  ]);
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', authenticate, authorize('super_admin', 'admin'), adminRoutes);
app.use('/api/permit', authenticate, permitRoutes);
app.use('/api/permit-birla', authenticate, permitBirlaRoutes);
app.use('/api/vehicle', authenticate, vehicleRoutes);
app.use('/api/visitor', authenticate, visitorRoutes);
app.use('/api/library', authenticate, libraryRoutes);
app.use('/api/safety', authenticate, safetyRoutes);

// Future module routes will be added here:
// app.use('/api/inventory', authenticate, requireSystemAccess('inventory'), inventoryRoutes);
// app.use('/api/vehicle', authenticate, requireSystemAccess('vehicle'), vehicleRoutes);
// app.use('/api/safety', authenticate, requireSystemAccess('safety'), safetyRoutes);
// app.use('/api/visitor', authenticate, requireSystemAccess('visitor'), visitorRoutes);
// app.use('/api/reception', authenticate, requireSystemAccess('reception'), receptionRoutes);
// app.use('/api/stationery', authenticate, requireSystemAccess('stationery'), stationeryRoutes);
// app.use('/api/license', authenticate, authorize('super_admin'), licenseRoutes);

// Error handling
app.use(errorHandler);

export default app;
