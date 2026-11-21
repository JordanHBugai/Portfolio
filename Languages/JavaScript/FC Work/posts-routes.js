/* For video/image posting routes */
import {
  Router
} from "express";
import multer, {
  memoryStorage
} from "multer";
import inputValidator from "../middleware/input_validator.js";
import rateLimiter from "../middleware/rate_limiter.js";
import {
  checkLike,
  checkView,
  getUserInfo,
  pgQuery,
  s3Delete,
  s3Retrieve,
  s3Upload,
  updatePosts,
  getUserInfoFromIdToken
} from "../functions/general_functions.js";
import getDynamoRequestBuilder from "../config/dynamoDB.js";
import redis from "../config/redisConfig.js";
import pgPool from "../config/pgdb.js";
import {
  blockedUsers,
  verifyTokens,
  verifyUserIdentity,
} from "../middleware/verify.js";

const router = Router();
const storage = memoryStorage();
const upload = multer({
  storage: storage
});


/* Testing Posts Route */
router.get("/testing/test/:post_id", inputValidator, async (req, res) => {
  try {

    res.status(200).json({
      "Testing": "Working Posts",
      "Value": req.body
    });
  } catch (err) {
    console.error(err.message);
  }
});



/**
 * Retrieves posts -- this is meant to be used with query parameters to
 * search for posts. Without query parameters, this returns ALL posts,
 * which is very expensive and in general SHOULD NOT be used.
 *
 * Currently, only the username (of the creator of the post)
 * and post title parameters are supported.
 *
 * @route GET /
 * @param {any} req.query.username - Username of the profile to search for
 * @param {any} req.query.title - Title of the post to search for
 * @returns {status} - If successful, returns 200 and a JSON object with the posts, else returns 400 and a JSON object with the message set to 'Unknown error occurred.'
 */
router.get("/", rateLimiter(), verifyTokens, blockedUsers, inputValidator, async (req, res, next) => {
  try {
    const {
      username = "",
      title = "",
      page = 1,
      pageSize = 10
    } = req.query;

    const user_id = parseInt(req.body.payload.user_id);

    const limit = parseInt(pageSize);
    const offset = (parseInt(page) - 1) * limit;

    // blocked users from payload
    const blockedUsersArray = Array.from(req.body.payload.blockedUsers);

    const query = `
      SELECT p.id, p.title, p.description, p.thumbnail_name, p.video_name, p.created_at, p.updated_at, u.username, pc.category_name,
      CASE
        WHEN b.user_id IS NOT NULL THEN true
        ELSE false
      END as bookmarked 
      FROM users u
      JOIN posts p ON p.user_id = u.id
      JOIN posts_categories pc ON p.id = pc.post_id
      LEFT JOIN bookmarks b ON p.id = b.post_id AND b.user_id = $5

      WHERE p.title ILIKE ('%' || $1 || '%') 
        AND u.username ILIKE ('%' || $2 || '%')
        AND u.id <> ALL($6::int[])

      LIMIT $3 OFFSET $4
    `;

    const countQuery = `
      SELECT COUNT(*) AS total
      FROM users u
      JOIN posts p ON p.user_id = u.id
      JOIN posts_categories pc ON p.id = pc.post_id
      WHERE p.title ILIKE ('%' || $1 || '%') AND u.username ILIKE ('%' || $2 || '%')
    `;

    // Retrieve total count of posts for pagination metadata
    const countResult = await pgQuery(countQuery, title, username);
    const totalPosts = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(totalPosts / limit);

    // Retrieve paginated posts based on query

    const posts = await pgQuery(query, title, username, limit, offset, user_id, blockedUsersArray);

    const tempPosts = posts.rows;

    // Retrieves additional data for all posts
    let updatedPosts = await updatePosts(tempPosts, user_id);

    for (let i = 0; i < updatedPosts.length; i++) {
      // Retrieve recipe_id for every post
      const results = await pgQuery(
        "SELECT * FROM recipes WHERE post_id=$1",
        updatedPosts[i].id
      );

      if (results.rows.length == 0) {
        // Set recipe_id to null if it does not exist
        updatedPosts[i].recipe_id = null;
      } else {
        // Append recipe_id to post object
        updatedPosts[i].recipe_id = results.rows[0].id;
      }

      // Retrieve user information, then remove duplicate username property
      updatedPosts[i].user = await getUserInfo(updatedPosts[i].username);
      delete updatedPosts[i].username;
    }

    return res.status(200).json({
      data: updatedPosts,
      meta: {
        totalPosts,
        totalPages,
        currentPage: parseInt(page),
        pageSize: limit
      }
    });
  } catch (err) {
    console.error(err);
    return res.status(400).json({
      message: "Unknown error occurred."
    });
  }
});

/**
 * Uploading a Post, video and recipe
 * This endpoint needs a request header called 'Authorisation' with both the access token and the ID token 
 * 
 * @route POST /
 * @body {string} req.body - This contains all of the information needed for creating a post.
 * @returns {status} - If successful, returns 200 and a JSON object with status set to 'Video Posted'
 * @throws {Error} - If there are errors, the post must not be posted and any posted information needs to be rolled back.
 */
router.post("/", verifyTokens, inputValidator, rateLimiter(500, 15), upload.any(), async (req, res, next) => {
  try {

    let user = await getUserInfoFromIdToken(req.headers.authorisation.split(" ")[2])
    let user_id = user.user_id


    const { title, description, recipe_description, preparation_time, serving_size, category } = req.body;

    let { ingredients } = req.body;
    ingredients = JSON.parse(ingredients);


    const S3_POST_PATH = "posts/active/";

    const [newVideoName, newThumbNaileName] = await Promise.all([
      s3Upload(req.files[0], S3_POST_PATH),
      s3Upload(req.files[1], S3_POST_PATH)
    ]);

    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");

      // Insert the post into the posts table
      const insertPostQuery = "INSERT INTO posts (user_id, title, description, video_name, thumbnail_name, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, NOW(), NOW()) RETURNING id as post_id";
      const postValues = [user_id, title, description, newVideoName, newThumbNaileName];
      const newPost = await client.query(insertPostQuery, postValues);
      const { post_id } = newPost.rows[0];

      // Insert the recipe into the recipes table
      const insertRecipeQuery = "INSERT INTO recipes (post_id, recipe_description, preparation_time, serving_size, updated_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id as recipe_id";
      const recipeValues = [post_id, recipe_description, preparation_time, serving_size];
      const newRecipe = await client.query(insertRecipeQuery, recipeValues);
      const { recipe_id } = newRecipe.rows[0];

      // Loop through recipe ingredients
      for (let i = 0; i < ingredients.length; i++) {
        const { productId, label, imageUrl, quantity, unit } = ingredients[i];
        // Insert product into products table if it doesn't exist
        const productExistsQuery = "SELECT id FROM products WHERE id = $1";
        const productExists = await client.query(productExistsQuery, [productId]);
        if (productExists.rows.length === 0) {
          const insertProductQuery = "INSERT INTO products (id, label, imageUrl) VALUES ($1, $2, $3)";
          await client.query(insertProductQuery, [productId, label, imageUrl]);
        }
        // Insert association into recipe_products table
        const insertRecipeProductQuery = "INSERT INTO recipe_products (recipe_id, product_id, quantity, unit) VALUES ($1, $2, $3, $4)";
        await client.query(insertRecipeProductQuery, [recipe_id, productId, quantity, unit]);
      }

      // Insert category into posts_categories table
      const insertCategoryQuery = "INSERT INTO posts_categories (post_id, category_name) VALUES ($1, $2)";
      const postCategoryValues = [post_id, category];
      await client.query(insertCategoryQuery, postCategoryValues);

      await client.query("COMMIT");
      res.status(200).json({ Status: "Video Posted" });

    } catch (err) {
      await Promise.all([
        s3Delete(S3_POST_PATH + req.files[0]),
        s3Delete(S3_POST_PATH + req.files[1])
      ]);

      await client.query("ROLLBACK");
      next(err);

    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});



/**
 * Retrieves post details of a specific post based off post ID
 * This endpoint needs a request header called 'Authorisation' with both the access token and the ID token 
 * 
 * @route GET /posts/:post_id/user_id
 * @param {any} req.params.post_id - The ID of the post to retrieve details for
 * @returns {status} - If successful, returns 200 and a JSON object containing details of the post such as id, title, description, video URL, thumbnail URL, details of user who posted the post, post likes count, post comments count and post view count.
 *                     Else, returns 404 and a JSON object with error message set to 'Post not found'
 * @throws {Error} - If there is error retrieving post details or validation issues do not retrieve anything
 */

router.get("/:post_id", rateLimiter(), verifyTokens, blockedUsers, inputValidator, async (req, res, next) => {
  try {
    const post_id = req.params.post_id;
    const blockedUsers = req.body.payload.blockedUsers

    const query = "SELECT p.id, p.title, p.description, p.video_name, p.thumbnail_name, u.username, u.full_name  FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = $1";
    const postDetails = await pgQuery(query, post_id);

    if (postDetails.rows.length === 0) {
      return res.status(404).json({ error: "Post not found" });
    }
    const post = postDetails.rows[0];


    // Array to store promises for s3Retrieve calls
    const s3Promises = [];

    // Retrieve user information asynchronously
    const userInfo = await getUserInfo(post.username);
    // Wait for user info retrieval
    if (blockedUsers.has(userInfo.id)) {
      return res.status(400).json({ responce: `User id ${userInfo.id} has been blocked by current current user` })
    }

    // Check if video_name exists and retrieve it from S3
    if (post.video_name) {
      s3Promises.push(s3Retrieve(post.video_name));
    }

    // Check if thumbnail_name exists and retrieve it from S3
    if (post.thumbnail_name) {
      s3Promises.push(s3Retrieve(post.thumbnail_name));
    }

    // Wait for all s3Retrieve promises to resolve
    const s3Results = await Promise.all(s3Promises);

    // Update postDetails with S3 retrieval results
    if (post.video_name) {
      post.video_name = s3Results.shift();
    }
    if (post.thumbnail_name) {
      post.thumbnail_name = s3Results.shift();
    }

    const responseData = {
      id: post.id,
      title: post.title,
      description: post.description,
      video_name: post.video_name,
      thumbnail_name: post.thumbnail_name,
      user: {
        id: userInfo.id,
        username: userInfo.username,
        full_name: userInfo.full_name, // Ensure this is not null if possible
        profile_picture: await s3Retrieve(userInfo.profile_picture)
      }
    };


    return res.status(200).json({ data: responseData });
  } catch (error) {
    next(error); // server side error
  }
});


/**
 * Delete a specific post
 * This endpoint needs a request header called 'Authorisation' with both the access token and the ID token
 * 
 * @route POST /:post_id
 * @body {string} req.params.post_id - Id of the post that is neeeded
 * @returns {status} - If successful, returns 200 and a JSON object with Status set to 'Post Deleted', else returns 404 with a JSON object with error set to 'Post not found.'
 * @throws {Error} - If there are errors dont delete any post.
 */
router.delete("/:post_id", rateLimiter(), verifyUserIdentity, inputValidator, async (req, res, next) => {
  try {

    const {
      post_id
    } = req.params;

    // Fetch post details from the database
    const post = await pgQuery("SELECT * FROM posts WHERE id = $1", post_id);

    // Ensure the post is present in the database or not
    if (post.rows.length === 0) {
      return res.status(404).json({
        error: "Post not found."
      });
    }

    // Extract the video_name, thumbnail_name and user_id from the post
    const {
      video_name,
      thumbnail_name,
      user_id
    } = post.rows[0];

    await pgQuery("DELETE FROM posts WHERE id = $1", post_id);
    // Delete files from S3 and remove likes/views
    await Promise.all([
      s3Delete(video_name),
      s3Delete(thumbnail_name),
      removeLikesAndViews(post_id)
    ]);

    res.status(200).json({
      "Status": "Post Deleted"
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Get a list of posts for a particular category
 * This endpoint needs a request header called 'Authorisation' with both the access token and the ID token 
 * 
 * @route GET /category/:category_id/:user_id
 * @param {any} req.params.category_id - ID of the category that is needed
 * @query {number} req.query.page_size - Number of posts to fetch per page (optional, default: 15)
 * @query {number} req.query.page_number - Page number to fetch (optional, default: 1)
 * @returns {status} - If successful, returns 200 and a JSON object with an array of posts for the specified category
 * @throws {Error} - If there are errors, no posts are retrieved
 */
//verifyTokens, 
router.get("/category/:category_name", verifyTokens, rateLimiter(), blockedUsers, inputValidator, async (req, res, next) => {
  try {
    const {
      payload
    } = req.body;
    const user_id = payload.user_id;

    // Extract category ID from URL parameters
    const { category_name } = req.params;
    let getCategoryId = await pgQuery("SELECT * FROM categories WHERE name ILIKE $1", category_name);
    let category_id = getCategoryId.rows.length > 0 ? getCategoryId.rows[0].id : null;

    const blockedUsers = Array.from(req.body.payload.blockedUsers)


    if (category_id == null) {
      return res.status(400).json({ error: "This category doesnt exist" })
    }

    // Get query parameters for pagination
    let pageSize = parseInt(req.query.page_size) || 15;
    let currentPage = parseInt(req.query.page_number) || 1;

    pageSize = pageSize == 0 ? 1 : pageSize;
    currentPage = currentPage == 0 ? 1 : currentPage;


    // Calculate the offset based on page size and page number
    const offset = (currentPage - 1) * pageSize;

    // SQL query to fetch specific category posts excluding blocked users
    const query = `
SELECT 
  p.*, 
  pc.category_name,
  CASE
    WHEN b.user_id IS NOT NULL THEN true
    ELSE false
  END as bookmarked
FROM 
  posts p
INNER JOIN 
  posts_categories pc ON p.id = pc.post_id
LEFT JOIN 
  bookmarks b ON p.id = b.post_id AND b.user_id = $4
WHERE 
  pc.category_name IN (SELECT name FROM categories WHERE id = $1)
  AND p.user_id != ALL($5)
ORDER BY 
  p.created_at DESC
LIMIT 
  $2 
OFFSET 
  $3;
`;


    // Execute the query with parameters
    const specificCategoryPosts = await pgQuery(query, category_id, pageSize, offset, user_id, blockedUsers);


    // Process the posts to add video and thumbnail URLs, view_count ,like_count
    let updatedPosts = await updatePosts(specificCategoryPosts.rows, user_id);


    for (let i = 0; i < updatedPosts.length; i++) {

      let recipe_id = await pgQuery("SELECT id FROM recipes WHERE post_id=$1", updatedPosts[i].post_id)

      if (recipe_id.rows.length == 0) {
        // Set recipe_id to null if it does not exist
        updatedPosts[i].recipe_id = null;
      } else {
        // Append recipe_id to post object
        updatedPosts[i].recipe_id = recipe_id.rows[0].id;
      }

      // Fetch the content creator details for each post
      let contentCreator = await pgQuery("SELECT username, full_name, profile_picture FROM users WHERE id = $1", updatedPosts[i].user_id);

      // Check if the content creator details exist
      if (contentCreator.rows.length > 0) {

        // Assign content creator details to the updated post
        updatedPosts[i].user = await getUserInfo(contentCreator.rows[0].username)
      } else {
        // If content creator details are not found, set content_creator to null
        updatedPosts[i].content_creator = null;
      }
    }

    res.status(200).json({
      "data": updatedPosts
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Get Posts For The Home Page
 * For now random posts, later implement the Algorithm
 * This endpoint needs a request header called 'Authorisation' with both the access token and the ID token 
 * 
 * @route GET /posts/homepage/user
 * @returns {status} - If successful, returns 200 and a JSON object with an array of objects of post information
 * @throws {Error} - If there are errors dont retrieve any posts.
 */

router.get("/homepage/user", inputValidator, verifyTokens, rateLimiter(), async (req, res, next) => {
  // getting user ID
  const {
    payload
  } = req.body;
  const user_id = payload.user_id;


  try {
    // Get posts liked by the user
    const postLikeCount = await getDynamoRequestBuilder("Likes").query("user_id", user_id).useIndex("user_id-created_at-index").exec();

    // Extract post IDs
    const likedPosts = postLikeCount.map(post => post.post_id);

    // Convert the array to an array literal
    const likedPostsLiteral = `{${likedPosts.join(",")}}`;

    // Get query parameters for pagination
    const pageSize = parseInt(req.query.page_size) || 15;
    const currentPage = parseInt(req.query.page_number) || 1;

    // Calculate the offset based on page size and page number
    const offset = (currentPage - 1) * pageSize;

    // SQL query to fetch homepage posts with additional user information
    const query = `
      SELECT p.id, p.title, p.description, p.video_name, p.thumbnail_name, p.created_at,
             u.username,
             COALESCE((SELECT COUNT(*) FROM bookmarks b WHERE b.user_id = $1 AND b.post_id = p.id), 0) AS is_bookmarked
      FROM posts p
      JOIN users u ON p.user_id = u.id
      WHERE p.id != ALL ($2::integer[])
      ORDER BY RANDOM()
      LIMIT $3 OFFSET $4;
    `;

    // Execute the query with parameters
    const randomPosts = await pgQuery(query, user_id, likedPostsLiteral, pageSize, offset);

    // Process the posts to add video and thumbnail URLs, like count, and view count
    const processedRandomPosts = await Promise.all(
      randomPosts.rows.map(async (post) => {

        const videoUrl = await s3Retrieve(post.video_name);
        const thumbnailUrl = await s3Retrieve(post.thumbnail_name);

        const likeCount = await getDynamoRequestBuilder("Likes").query("post_id", post.id).exec();
        const viewCount = await getDynamoRequestBuilder("Views").query("post_id", post.id).exec();

        const isLiked = await checkLike(post.id, user_id);
        const isViewed = await checkView(post.id, user_id);
        const user = await getUserInfo(post.username)

        return {
          ...post,
          user: user,
          video_url: videoUrl,
          thumbnail_url: thumbnailUrl,
          like_count: likeCount.length,
          view_count: viewCount.length,
          is_liked: isLiked,
          is_viewed: isViewed,
        };
      })
    );

    // Respond with an object containing the "posts" key and the array of objects with post information
    res.status(200).json({
      posts: processedRandomPosts
    });
  } catch (err) {
    next(err);
  }
});


/**
 * Update Post Title and Title Description
 * This endpoint needs a request header called 'Authorisation' with both the access token and the ID token
 * 
 * @route PUT /posts/:post_id
 * @param {any} req.params.post_id - The ID of the post to update
 * @body {string} req.body.title - The updated title
 * @body {string} req.body.description - The updated title description
 * @returns {status} - If successful, returns 200 and a JSON object with Status set to 'Post Title and Title Description Updated', else returns 500 and a JSON object with message set to 'Post not updated'
 * @throws {Error} - If there are errors during the update
 */
router.put("/:post_id", verifyUserIdentity, inputValidator, rateLimiter(), async (req, res, next) => {
  try {
    const {
      post_id
    } = req.params;
    const {
      title,
      description
    } = req.body;

    // Update the post title and title description
    try {
      await pgQuery("UPDATE posts SET title = $1, description = $2, updated_at = NOW() WHERE id = $3", title, description, post_id);
    } catch (error) {
      return res.status(500).json({
        message: "Post not updated"
      });
    }
    res.status(200).json({
      Status: "Post Title and Title Description Updated"
    });

  } catch (err) {
    next(err);
  }
});

/**
 * Retrieves user posts based on search text 
 * 
 * @route GET posts/search/user-posts
 * @param {any} req.body.search_text - Text to search for in user posts
 * @returns {status} If successful, returns 200 and a JSON object of the users and posts matching the search criteria, else returns 500 and a JSON object with response set to 'Internal server error'
 * @throws {Error} If there are errors, no posts are retrieved
 */
router.get("/search/user-posts/:searchText", verifyTokens, rateLimiter(), inputValidator, async (req, res) => {
  try {
    // Extract search text from URL params
    const search_text = req.params.searchText


    // Define SQL queries
    const usersQuery = `
      SELECT id, username, profile_picture, full_name
      FROM users
      WHERE LOWER(username) LIKE LOWER($1)
    `;
    const postsQuery = `
      SELECT *
      FROM posts
      WHERE LOWER(title) LIKE LOWER($1)
    `;

    // Execute SQL queries to fetch users and posts
    const users = await pgQuery(usersQuery, `%${search_text}%`);
    const posts = await pgQuery(postsQuery, `%${search_text}%`);

    // Iterate through posts to fetch content creators. We only need content creators for posts
    for (let i = 0; i < posts.rows.length; i++) {
      const {
        id,
        user_id,
        title,
        description,
        video_name,
        thumbnail_name,
        created_at,
        updated_at
      } = posts.rows[i];

      // Query for content creator based on user_id
      const contentCreatorQuery = await pgQuery(
        "SELECT id, username, profile_picture FROM users WHERE id=$1", user_id
      );
      const contentCreator = contentCreatorQuery.rows[0];

      // Update current post with content creator information
      posts.rows[i] = {
        id,
        user_id,
        title,
        description,
        video_name,
        thumbnail_name,
        created_at,
        updated_at,
        contentCreator
      };
    }

    // Send response with users and posts data
    res.status(200).json({
      users: users.rows,
      posts: posts.rows
    });
  } catch (error) {
    // Handle errors
    console.error("Error in search query:", error);
    res.status(500).json({
      response: "Internal server error"
    });
  }
});




export default router;