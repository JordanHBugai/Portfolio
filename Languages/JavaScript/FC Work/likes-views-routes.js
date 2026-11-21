import { Router } from "express";

import rateLimiter from "../middleware/rate_limiter.js";
import inputValidator from "../middleware/input_validator.js";

import { setCommentsLike, setLikes, setStoryViews, setViews } from "../dynamo_schemas/dynamo_schemas.js";
import getDynamoRequestBuilder from "../config/dynamoDB.js";
import { verifyTokens, verifyUserIdentity } from "../middleware/verify.js";

const router = Router();

/* Testing Posts Route */
router.get("/testing", async (req, res) => {
  try {
    res.json({ "Testing": "Working Posts" });
  } catch (err) {
    console.error(err.message);
  }
});

/**
 * Process A Video Like
 * This endpoint needs a request header called 'Authorisation' with both the access token and the ID token 
 * 
 * @route POST /like/:post_id/user/:user_id
 * @param {any} req.params.post_id - The ID of the video post being liked
 * @returns {status} - If successful, returns 200 with a JSON object with the status set to 'Post Liked', else returns 409 and a JSON object with message set to 'Post Like Already Exists'
 * @throws {Error} - If there is an error, the post liking failed 
 */
router.post("/like/:post_id/user", rateLimiter(), verifyTokens, inputValidator, async (req, res, next) => {
  try {
	  const { post_id } = req.params;
    const { payload } = req.body;
    const user_id = payload.user_id;
	  const likeSchema = setLikes(parseInt(user_id), parseInt(post_id));
  
	  // Check if the like exists
	  const checkLikeExistence = await getDynamoRequestBuilder("Likes")
      .query("post_id", parseInt(post_id))
      .whereSortKey("user_id")
      .eq(parseInt(user_id))
      .exec();
  
	  if (checkLikeExistence.length === 0) {
      // Like does not exist, proceed to like
      await getDynamoRequestBuilder("Likes").put(likeSchema).exec();
      res.status(200).json({ "Status": "Post Liked" });
	  } else {
		  // Like already exists
      res.status(409).json({ message: "Post Like Already Exists" });
	  }
  } catch (err) {
	  next(err);
  }
});
  
/**
   * Remove A Video Like 
   * This endpoint needs a request header called 'Authorisation' with both the access token and the ID token 
   * 
   * @route DELETE /like/:post_id/user/:user_id
   * @param {any} req.params.post_id - The ID of the video post being unliked
   * @returns {status} - If successful, returns 200 and a JSON object with the status set to 'Post Unliked', else returns 404 and a JSON ojbect with message set to 'Post Like Not Found'
   * @throws {Error} - If there is an error, the post is already unliked 
   */
router.delete("/like/:post_id/user", rateLimiter(), verifyTokens, inputValidator, async (req, res, next) => {
  try {
	  const { post_id } = req.params;
    const { payload } = req.body;
    const user_id = payload.user_id;
	  // Check if the like exists
	  const checkLikeExistance = await getDynamoRequestBuilder("Likes")
      .query("post_id", parseInt(post_id))
      .whereSortKey("user_id")
      .eq(parseInt(user_id))
      .exec();
  
	  if (checkLikeExistance && checkLikeExistance.length > 0) {
  
      // Like exists, proceed to delete it
      await getDynamoRequestBuilder("Likes")
		  .delete("post_id", parseInt(post_id))
		  .withSortKey("user_id", parseInt(user_id))
		  .exec();
      res.status(200).json({ "Status": "Post Unliked" });
	  } else {
  
      // Like does not exist
      res.status(404).json({  message: "Post Like Not Found" });
	  }
  } catch (err) {
	  next(err);
  }
});

/** 
 * Posting a like for a specific comment
 * This endpoint needs a request header called 'Authorisation' with both the access token and the ID token 
 * 
 * @route POST /posts/comment/like/:id
 * @param {any} req.params.id - The ID of the comment being liked
 * @body {string} req.params.post_id - The ID of the post with the comment
 * @returns {status} - If successful, returns a JSON ojbect with the status set to 'Comment Liked'
 * @throws {Error} - If there are errors, the comment liking failed
 */
router.post("/posts/comment/like/:id", rateLimiter(), verifyTokens, inputValidator, async (req, res, next) => {
  try {

    const commentId = req.params.id;
    const { payload, post_id } = req.body;
    const user_id = payload.user_id;

    const commentLikeSchema = setCommentsLike(parseInt(user_id), commentId);
		
    const putCommentLikesRequest = getDynamoRequestBuilder("Comment_Likes").put(commentLikeSchema);
		
    const updateCommentsRequest = getDynamoRequestBuilder("Comments")
      .update("post_id", parseInt(post_id))
      .withSortKey("comment_id", commentId)
      .updateAttribute("comment_like_count").increment();
		
    await Promise.all([
      putCommentLikesRequest.exec(),
      updateCommentsRequest.exec()
    ]);

    res.status(200).json({ "Status": "Comment Liked" });
  } catch (err) {
    next(err);
  }
});

/**
   * Deleting a like on a specific comment
   * This endpoint needs a request header called 'Authorisation' with both the access token and the ID token
   * 
   * @route DELETE /like/:post_id/user/:user_id
   * @param {any} req.params.id - The ID of the comment being unliked
   * @body {string} req.params.post_id - The ID of the post with the comment
   * @returns {status} - If successful, returns 200 and a JSON object with the status set to 'Comment Unliked'
   * @throws {Error} If there is an error, the comment unliking failed
   */
router.delete("/posts/comment/like/:id", rateLimiter(), verifyUserIdentity, inputValidator, async (req, res, next) => {
  try {
    const commentId = req.params.id;
    const { comment_like_id, post_id } = req.body;
		
    const deleteCommentLikesRequest = getDynamoRequestBuilder("Comment_Likes")
      .delete("comment_like_id", comment_like_id)
      .withSortKey("comment_id", commentId);
		
    const updateCommentsRequest = getDynamoRequestBuilder("Comments")
      .update("comment_id", commentId)
      .withSortKey("post_id", parseInt(post_id))
      .updateAttribute("comment_like_count").decrement();
		
    await Promise.all([
      deleteCommentLikesRequest.exec(),
      updateCommentsRequest.exec()
    ]);

    res.status(200).json({ Status: "Comment Unliked" });
  } catch (err) {
    next(err);
  }
});

/**
 * User View A Story
 * This will update the DynamoDB Story_Views Table and process a story view happening
 * This endpoint needs a request header called 'Authorisation' with both the access token and the ID token 
 * 
 * @route POST /story:story_id/view:user_id
 * @param {any} req.params.story_id - The unique identifier of the story being viewed.
 * @returns {status} - If successful, returns 200 with a JSON object with the status set to 'Story viewed successfully', else returns 409 with a JSON object with message set to 'Story already viewed by the user'
 * @throws {Error} - If there is an error viewing the user story
**/
router.post("/story/:story_id/view", rateLimiter(), verifyTokens, inputValidator, async (req, res, next) => {
  try {
    const { story_id } = req.params;
    const { payload } = req.body;
    const user_id = payload.user_id;
    const StoryViewSchema = setStoryViews(story_id, parseInt(user_id));

    // Check if the story view exists
    const checkStoryViewExistence = await getDynamoRequestBuilder("Story_Views")
      .query("story_id", story_id)
      .whereSortKey("user_id")
      .eq(parseInt(user_id))
      .exec();

    if (checkStoryViewExistence.length === 0) {
      //Story View does not exist, proceed to View
      await getDynamoRequestBuilder("Story_Views").put(StoryViewSchema).exec();
      res.status(200).json({ "Status": "Story viewed successfully" });
    } else {
      // Story View already exists
      res.status(409).json({  message: "Story already viewed by the user." });
    }
  }
  catch (err) {
    next(err);
  }
});

/** 
 * Update Post View
 * This will update the DynamoDB Views Table and process a view happening
 * This endpoint needs a request header called 'Authorisation' with both the access token and the ID token 
 * 
 * @route POST /post:post_id/view:user_id
 * @param {any} req.params.post_id - The unique identifier of the post being viewed.
 * @returns {status} - If successful, returns 200 and a JSON object with status set to 'Post viewed successfully', else returns 409 with message set to 'Post already viewed by the user.'
 * @throws {Error} - If there are errors during processing
 */
router.post("/post/:post_id/view", rateLimiter(), verifyTokens, inputValidator, async (req, res, next) => {
  try {
    const { post_id } = req.params;
    const { payload } = req.body;
    const user_id = payload.user_id;
    const ViewSchema = setViews(parseInt(user_id), parseInt(post_id));

    // Check if the view exists
    const checkViewExistence = await getDynamoRequestBuilder("Views")
      .query("post_id", parseInt(post_id))
      .whereSortKey("user_id")
      .eq(parseInt(user_id))
      .exec();

    if (checkViewExistence.length === 0) {
      // View does not exist, proceed to View
      await getDynamoRequestBuilder("Views").put(ViewSchema).exec();
      res.status(200).json({ "Status": "Post viewed successfully" });
    } else {
      // View already exists
      res.status(409).json({  message: "Post already viewed by the user." });
    }
  }
  catch (err) {
    next(err);
  }

});

export default router;