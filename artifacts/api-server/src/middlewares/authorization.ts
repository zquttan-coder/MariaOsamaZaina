import type { RequestHandler } from "express";

export const requireInstructor: RequestHandler = (req, res, next): void => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  if (req.user.role !== "instructor") {
    res.status(403).json({ error: "Instructor role required" });
    return;
  }

  next();
};

export const requireAdmin: RequestHandler = (req, res, next): void => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  if (req.user.role !== "admin") {
    res.status(403).json({ error: "Administrator role required" });
    return;
  }

  next();
};