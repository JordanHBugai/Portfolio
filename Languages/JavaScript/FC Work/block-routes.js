import { Router } from "express";
import inputValidator from "../middleware/input_validator.js";
import rateLimiter from "../middleware/rate_limiter.js";
import pgPool from "../config/pgdb.js";
import { verifyAccessOnly, verifyTokens } from "../middleware/verify.js";
import { pgQuery } from "../functions/general_functions.js";

const router = Router();

/**
 * Retrieve Blocked Users for Authenticated User
 * This endpoint retrieves the list of users blocked by the authenticated user.
 * This endpoint needs a request header called 'Authorisation' with both the access token and the ID token
 *
 * @route GET /posts/block/
 * @returns {object} Returns JSON object containing an array of blocked users
 * @throws {Error} If there are errors while fetching blocked users
 */
router.get("/posts/block/", rateLimiter(), verifyTokens, async (req, res, next) => {
  const psqlClient = await pgPool.connect();

  try {
    // Get the authenticated user's ID from the request
    const userId = req.body.payload.user_id;

    // Validate the user ID
    if (!userId) {
      return res.status(400).json({ error: "User ID is required" });
    }

    // Query to retrieve blocked users for the authenticated user
    const queryBlockedUsers = `
      SELECT blocked_user_id, created_at 
      FROM blocked_users 
      WHERE user_id = $1 AND blockcreator = TRUE
    `;

    // Execute the query with the authenticated user's ID as a parameter
    const blockedUsersResult = await psqlClient.query(queryBlockedUsers, [userId]);

    // Check if any blocked users were found
    if (blockedUsersResult.rowCount === 0) {
      return res.status(404).json({ message: "No blocked users found" });
    }

    // Send the blocked users data as response
    res.status(200).json({ blockedUsers: blockedUsersResult.rows });
  } catch (err) {
    // Log the error and pass it to the error handling middleware
    console.error("Failed to fetch blocked users:", err);
    next(err);
  } finally {
    // Ensure the database connection is always released
    psqlClient.release();
  }
});



/**
 * Posting Block For Specific User
 * This endpoint needs a request header called 'Authorisation' with both the access token and the ID token.
 *
 * @route POST  /posts/block/
 * @body {string} req.body.user_id - The ID of the user getting blocked
 * @returns {status} - Returns 200 for successful block, 400 if user is already blocked
 * @throws {Error} - If there are errors, the comment posting failed
 */
router.post("/posts/block/", rateLimiter(), verifyTokens, inputValidator, async (req, res, next) => {
  const psqlClient = await pgPool.connect();

  try {
    // Parsing and validating inputs
    const blockingUserId = parseInt(req.body.payload.user_id);
    const blockedUserId = parseInt(req.body.user_id);

    if (isNaN(blockingUserId) || isNaN(blockedUserId)) {
      return res.status(400).json({ error: "Invalid user IDs provided" });
    }

    // Check if a block already exists for this user and the blocked user
    const checkBlockQuery = `
      SELECT * FROM blocked_users 
      WHERE user_id = $1 AND blocked_user_id = $2
    `;
    const blockExists = await psqlClient.query(checkBlockQuery, [blockingUserId, blockedUserId]);

    if (blockExists.rowCount > 0) {
      return res.status(400).json({ status: "User is already blocked." });
    }
    // Insert the block entries
    const insertBlockQuery = `
      INSERT INTO blocked_users (user_id, blocked_user_id, blockCreator) 
      VALUES 
        ($1, $2, $3),
        ($2, $1, $4)
    `;
    await psqlClient.query(insertBlockQuery, [blockingUserId, blockedUserId, true, false]);

    return res.status(201).json({ status: "Block posted successfully" });
  } catch (err) {
    console.error("Posting Block Failed:", err);
    next(err);
  } finally {
    psqlClient.release();
  }
});


/**
 * Delete Block For Specific User
 * This endpoint needs a request header called 'Authorisation' with both the access token and the ID token
 *
 * @route POST  /posts/block/
 * @body {string} req.body.user_id - The ID of the user getting unblocked
 * @returns {status} - Returns a status of comment if posted successfully
 * @throws {Error} - If there are errors, the user could not be located (404)
 */

router.delete("/posts/block/", rateLimiter(), verifyTokens, inputValidator, async (req, res, next) => {
  const psqlClient = await pgPool.connect();

  try {
    // Parsing and validating inputs
    const unblockingUserId = parseInt(req.body.payload.user_id)
    const unblockedUserId = parseInt(req.body.user_id);

    if (isNaN(unblockingUserId) || isNaN(unblockedUserId)) {
      return res.status(400).json({ error: "Invalid user IDs provided" });

    }

    // Check if the block entry exists
    const checkBlockQuery = `
      SELECT * FROM blocked_users 
      WHERE user_id = $1 AND blocked_user_id = $2
    `;
    const response = await psqlClient.query(checkBlockQuery, [unblockingUserId, unblockedUserId]);

    if (response.rowCount < 1) {
      return res.status(404).json({ error: "Block not found" });
    }

    const blockRecord = response.rows[0];
    if (!blockRecord.blockcreator) {
      return res.status(403).json({ error: "Only the author of the block can remove it" });
    }

    // Delete the block entry
    const deleteBlockQuery = `
      DELETE FROM blocked_users 
      WHERE (user_id = $1 AND blocked_user_id = $2) 
         OR (user_id = $2 AND blocked_user_id = $1)
    `;
    const deleteResponse = await psqlClient.query(deleteBlockQuery, [unblockingUserId, unblockedUserId]);

    if (deleteResponse.rowCount === 0) {
      return res.status(404).json({ error: "Failed to locate user in blocked list" });
    }

    return res.status(200).json({ status: "Block deleted successfully" });
  } catch (err) {
    console.error("Deleting Block Failed:", err);
    next(err);
  } finally {
    psqlClient.release();
  }
});


export default router;