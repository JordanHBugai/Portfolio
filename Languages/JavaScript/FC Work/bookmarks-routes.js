import { Router } from "express";
import rateLimiter from "../middleware/rate_limiter.js";
import inputValidator from "../middleware/input_validator.js";
import { checkLike, checkView, pgQuery, s3Retrieve, updatePosts } from "../functions/general_functions.js";
import { verifyTokens } from "../middleware/verify.js";
import redis from "../config/redisConfig.js";

const router = Router();

/**
 * Removes a post that has been bookmarked by a user.
 * This endpoint needs a request header called 'Authorisation' with both the access token and the ID token 
 * 
 * @route DELETE /profile/:userid/bookmark/:postid
 * @param {any} req.params.post_id - The ID of the post to unbookmark
 * @returns {status} - A status indicating successful removal of post from bookmarks
 * @throws {Error} - If there are errors removing post (400)
 */
router.delete("/profile/bookmark/:post_id", rateLimiter(), verifyTokens, inputValidator, async (req, res, next) => {
  try {
    const { post_id } = req.params; // retrieving postID
    const user_id = req.body.payload.user_id; // Retriving user_id from JWT token 

    const query = "DELETE FROM bookmarks WHERE user_id = $1 AND post_id = $2"; // query to remove post from bookmarks
    const postgresQuery = await pgQuery(query, user_id, post_id);

    if (postgresQuery.rowCount === 1) { // if statement to check if removal was successful
      const categoryKeys = await redis.keys('CATEGORY|*');
      if (categoryKeys.length > 0) {
        await redis.del(categoryKeys);
      }
      res.status(200).json({ message: "Post is no longer bookmarked" }); // if true success response code is sent
    }
    else if (postgresQuery.rowCount === 0) {
      res.status(400).json({ message: "This post has already been deleted" });
    }
    else {
      res.status(400).json({ message: postgresQuery.error }); // else unsuccessful response code is sent along with error message
    }
  } catch (error) {
    next(error); // server side error
  }
});

/**
 * Bookmarks a post
 * This endpoint needs a request header called 'Authorisation' with both the access token and the ID token 
 * 
 * @route POST /post/:user_id/bookmark/:post_id
 * @param {any} req.params.post_id - The ID of the post to bookmark
 * @returns {status} - A status indicating successful bookmark of post
 * @throws {Error} - If there are errors bookmarking post (400)
 */
router.post("/post/bookmark/:post_id", rateLimiter(), verifyTokens, inputValidator, async (req, res, next) => {
  try {
    const { post_id } = req.params; // retrieving postID
    const user_id = req.body.payload.user_id; // retrieving user_id from JWT token

    //check if post is already bookmarked for user
    const checkQuery = "SELECT COUNT(*) FROM bookmarks WHERE user_id = $1 AND post_id = $2";
    const checkResult = await pgQuery(checkQuery, user_id, post_id);

    if(checkResult.rows[0].count>0){
      //Post is already bookmarked, send message
      res.status(400).json({ message: "Post already bookmarked" });
    } else {  
      //if Post is not bookmarked, proceed to insert bookmark
    const query = "INSERT INTO bookmarks (user_id, post_id, created_at) VALUES ($1, $2, NOW())"; // query to add a post to bookmarks
    const postgresQuery = await pgQuery(query, user_id, post_id);

    if (postgresQuery.rowCount === 1) { // if statement to check post was added
      // Invalidate cache for categories containing the bookmarked post
      const categoryKeys = await redis.keys('CATEGORY|*');
      if (categoryKeys.length > 0) {
        await redis.del(categoryKeys);
      }
      res.status(200).json({ message: "Post bookmarked" }); // if true success response code is sent
    } else {
      res.status(400).json({ message: postgresQuery.error }); // else unsuccessful response code is sent along with error message
    }
  }
  } catch (error) {
    next(error); // server side error
  }
});

/**
 * Gets posts which have been bookmarked by a user
 * 
 * @route GET /profile/:user_id/bookmark/
 * @param {any} req.params.user_id - The ID of the user
 * @returns {status} - If successful, returns 200 and an array of the posts bookmarked by the user
 * @throws {Error} - If there are errors fetching bookmarked posts
 */
router.get("/:user_id", rateLimiter(), verifyTokens, inputValidator, async (req, res, next) => {
  try {
    const { user_id } = req.params; // retrieving userID
    const { page_number, page_size } = req.params;// getting page number and page size

    // query to get bookmarked post details
    const bookmarkPostsQuery = `
    SELECT 
      p.id, 
      p.title, 
      p.description, 
      p.video_name, 
      p.thumbnail_name, 
      p.created_at,
      p.updated_at,
      pc.category_name, 
      u.id AS user_id,
      u.username, 
      u.full_name, 
      u.profile_picture, 
      r.id AS recipe_id,
      CASE 
        WHEN fol.user_following_id IS NOT NULL THEN true 
        ELSE false 
      END as isFollowed,
      CASE
        WHEN b2.user_id IS NOT NULL THEN true
        ELSE false
      END as bookmarked
    FROM 
      posts p 
    JOIN 
      bookmarks b ON p.id = b.post_id AND b.user_id = $1
    JOIN 
      users u ON p.user_id = u.id
    JOIN
      posts_categories pc ON pc.post_id = p.id
    LEFT JOIN
      following fol ON u.id = fol.user_following_id AND fol.user_id = $1
    LEFT JOIN
      recipes r ON r.post_id = p.id
    LEFT JOIN
      bookmarks b2 ON p.id = b2.post_id AND b2.user_id = $1
    WHERE 
      b.user_id = $1 
    ORDER BY 
      b.created_at DESC 
    LIMIT $3 
    OFFSET (($2 - 1) * $3)`;  

    // query to get bookmarked post details
    const bookmarkPostsQueryPromise = await pgQuery(bookmarkPostsQuery, user_id, page_number, page_size);
    const updatedPostsData = await updatePosts(bookmarkPostsQueryPromise.rows, parseInt(user_id)); // updating post objects to include further information

    // Attempt to retrieve profile picture of user of each bookmarked post
    Promise.allSettled(
      updatedPostsData.map(async(posts) =>{
        let contentCreator = await pgQuery("SELECT id,username,profile_picture FROM users WHERE id =$1", posts.user_id);
        posts.profile_picture = (contentCreator.rows[0].profile_picture !== null) ? await s3Retrieve(contentCreator.rows[0].profile_picture) : null;
      }
    )
  );

    // Query to retrieve Bookmarker's information
    const bookmarkerQuery = `
      SELECT 
        id, username, profile_picture, full_name 
      FROM 
        users 
      WHERE 
        id = $1`;

    // Execute the query to retrieve bookmarker's information
    const bookmarker = await pgQuery(bookmarkerQuery, user_id);
    let bookmarkerData = {};

    if (bookmarker.rows.length > 0) {
      // If bookmarker's information is found, retrieve profile picture from S3
      const bookmarkerInfo = bookmarker.rows[0];
      if (bookmarkerInfo.profile_picture != null) {
        bookmarkerInfo.profile_picture = await s3Retrieve(bookmarkerInfo.profile_picture)
      }
      bookmarkerData = {
       user: { 
        id: bookmarkerInfo.id,
        username: bookmarkerInfo.username,
        fullname: bookmarkerInfo.full_name,
        profile_picture: bookmarkerInfo.profile_picture
       }}
    }

    const responseData = updatedPostsData.map(post => {
      const { user_id, full_name, profile_picture, username, ...postWithoutUser } = post;
      return {
        ...postWithoutUser,
        // User information is nested under each post
        user: {
          user_id,
          full_name,
          profile_picture,
          username
        }
      };
    });

    res.status(200).json({
      data: responseData,
      bookmarker: bookmarkerData // Include bookmarker's information in the response
    }); // sending data to client (if array is empty it means user has no posts bookmarked or posts information does not exist in database)
  } catch (error) {
    next(error); // server side error
  }
});




export default router;
