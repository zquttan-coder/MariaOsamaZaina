import { Router, type IRouter } from "express";
import healthRouter from "./health";
import questionsRouter from "./questions";
import practiceRouter from "./practice";
import bookmarksRouter from "./bookmarks";
import { requireInstructor } from "../middlewares/authorization";
import adminRouter from "./admin";
import authRouter from "./auth";
import instructorPreferencesRouter from "./instructor-preferences";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use("/admin", adminRouter);
router.use("/instructor", requireInstructor);
router.use(instructorPreferencesRouter);
router.use(questionsRouter);
router.use(practiceRouter);
router.use(bookmarksRouter);

export default router;
