import dotenv from 'dotenv';
dotenv.config();

export const environment = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    poolSize: parseInt(process.env.DB_POOL_SIZE || '10', 10),
  },

  databases: {
    portal: process.env.DB_PORTAL || 'portal',
    login: process.env.DB_LOGIN || 'login',
    permit: process.env.DB_PERMIT || 'permit',
    permitModern: process.env.DB_PERMIT_MODERN || 'permit_modernized',
    vehicle: process.env.DB_VEHICLE || 'vehicle_mgmt',
    safety: process.env.DB_SAFETY || 'safety_mgmt',
    visitor: process.env.DB_VISITOR || 'visitor_mgmt',
    inventory: process.env.DB_INVENTORY || 'inventory',
    stationery: process.env.DB_STATIONERY || 'stationery',
    reception: process.env.DB_RECEPTION || 'reception',
    library: process.env.DB_LIBRARY || 'library_mgmt',
    permitBirla: process.env.DB_PERMIT_BIRLA || 'permit_birla',
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'change-me-in-production',
    expiresIn: process.env.JWT_EXPIRES_IN || '1h',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  },

  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:4200',
  },

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
    max: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
  },
};
