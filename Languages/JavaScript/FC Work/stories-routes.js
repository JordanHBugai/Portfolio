/* For stories routes */
import { Router, query } from "express";
import multer, { memoryStorage } from "multer";
import inputValidator from "../middleware/input_validator.js";
import rateLimiter from "../middleware/rate_limiter.js";


import { pgQuery, s3Delete, s3Upload, s3Retrieve, getUserInfoFromIdToken, checkReactionExists } from "../functions/general_functions.js";
import getDynamoRequestBuilder from "../config/dynamoDB.js";

import { setStory, setStoryReactions } from "../dynamo_schemas/dynamo_schemas.js";
import { verifyTokens } from "../middleware/verify.js";

const router = Router();
const storage = memoryStorage();
const upload = multer({ storage: storage });


// Testing stories
router.get("/testing", async (req, res, next) => {
  try {
    res.status(200).json({ Status: "Stories" });
  } catch (err) {
    next(err);
  }
});

/**
 * Retrieves stories of users that are followed by the user 
 * This endpoint needs a request header called 'Authorisation' with both the access token and the ID token 
 * 
 * @route GET /following_stories
 * @query {string} req.query.page_number - The page number for pagination.
 * @query {string} req.query.page_size - The page size for pagination.
 * @returns {status} - If successful, returns 200 and a JSON object containing story information such as story id, video URL, thumbnail URL, view count, created at. Else returns 400 and a JSON object with associated error message
 * @throws {Error} - If there is error retrieving stories
 */
router.get("/following_stories",verifyTokens,rateLimiter(), inputValidator, async (req, res, next) => {
  try {
    // Retrieve body data including userId from payload and page size and number
    const page_size = parseInt(req.query.page_size, 10) || 15;
    const page_number = parseInt(req.query.page_number, 10) || 1;
    // const { payload } = req.body;
    const {payload} = req.body;
    const userID = payload.user_id;


    // Conditions to check if page_number or page_size body variable is not null
    if (isNaN(page_number) || isNaN(page_size)) {
      return res.status(400).json({ message: "Invalid page_number or page_size" });
    }

    // Getting users the user follows
    const query = `
      SELECT following.user_following_id, users.username, users.profile_picture, users.full_name 
      FROM following 
      JOIN users ON following.user_following_id = users.id 
      WHERE following.user_id = $1 
      ORDER BY following.created_at ASC
    `;

    // Executing the Postgres SQL query to retrieve which users the current author is following
    const userFollowing = await pgQuery(query, userID);

    // Used to map all new story objects
    const userStoryMap = {};

    // Traverse through all the followers and retrieve all their stories
    await Promise.all(userFollowing.rows.map(async (user) => {
      try {
        // Getting the following user's stories
        let stories = await getDynamoRequestBuilder("Stories")
          .query("user_id", parseInt(user.user_following_id, 10))
          .useIndex("user_id-created_at-index")
          .scanIndexDescending()
          .exec();

        // Filter stories that are older than 24 hours
        const ONE_DAY = 1000 * 60 * 60 * 24;
        stories = stories.filter(story => (Date.now() - Date.parse(story.created_at)) < ONE_DAY);

        if (stories.length === 0) return;

        if (!userStoryMap[user.user_following_id]) {
          let profilePictureUrl = null;
          if (user.profile_picture) {
            try {
              // Retrieve profile picture URL from S3
              profilePictureUrl = await s3Retrieve(user.profile_picture);
            } catch (err) {
              console.error(`Error retrieving profile picture for user ${user.user_following_id}:`, err);
            }
          }

          // Initialize user story map with user details under 'user' key and stories under 'stories' key
          userStoryMap[user.user_following_id] = {
            user: {
              user_id: user.user_following_id,
              profile_picture: profilePictureUrl,
              username: user.username,
              full_name: user.full_name, // Assuming full_name is needed
            },
            stories: [],
          };
        }

        await Promise.all(stories.map(async (story) => {
          let reactionID = null;
          // Retrieve story image URL from S3
          const imageUrl = await s3Retrieve(story.imageUrl);
          const reactions = await getDynamoRequestBuilder("Story_Reactions")
            .query("story_id", story.story_id)
            .useIndex("story_id-index")
            .scanIndexDescending()
            .exec();

          // Find the reaction of the current user on the story
          for (let i = 0; i < reactions.length; i++) {
            if (reactions[i].user_id === userID) {
              reactionID = reactions[i].reaction_Id;
              break;
            }
          }

          // Add story details to the user's stories
          userStoryMap[user.user_following_id].stories.push({
            story_id: story.story_id,
            image_url: imageUrl,
            created_at: story.created_at,
            reactionID: reactionID,
          });
        }));
      } catch (error) {
        console.error(error);
        throw new Error('Failed to process user stories');
      }
    }));

    // Convert userStoryMap object to an array
    const userStoriesArray = Object.values(userStoryMap);
    res.status(200).json({ data: userStoriesArray });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});



/**
 * Retrieves a user's  saved stories
 * This endpoint needs a request header called 'Authorisation' with both the access token and the ID token 
 * 
 * @route GET /user/:user_id
 * @query {string} req.query.page_number - The page number for pagination
 * @query {String} req.query.page_size - The page size for pagination
 * @returns {status} - If successful, returns 200 and a JSON object of  list of stories that have been saved sorted by created_at, else returns 400 and a JSON object with message set to 'Invalid page_number or page_size', else returns 500 and error message
 * @throws {Error} - If there is error in retrieving stories
 */
router.get("/",verifyTokens,rateLimiter(),inputValidator, async (req, res, next) => {
  try {
    const {payload}=req.body
    const user_id =payload.user_id ;
    const pageSize = parseInt(req.query.page_size, 10) || 15;
    const pageNumber = parseInt(req.query.page_number, 10) || 1;

    if (isNaN(pageNumber) || isNaN(pageSize)) {
      return res.status(400).json({ message: "Invalid page_number or page_size" });
    }

    // Retrieve user details from the database
    const userQuery = "SELECT full_name, username, profile_picture FROM users WHERE id=$1";
    const userDetails = await pgQuery(userQuery, parseInt(user_id, 10));

    if (userDetails.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const userDetail = userDetails.rows[0];

    // Calculate the offset for pagination
    const offset = (pageNumber - 1) * pageSize;

    try {
      // Retrieve user stories from DynamoDB
      const stories = await getDynamoRequestBuilder("Stories")
        .query("user_id", parseInt(user_id, 10))
        .useIndex("user_id-created_at-index")
        .scanIndexDescending()
        .limit(pageSize)
        .exec();

      // Sort stories by creation date in descending order
      const sortedStories = stories.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

      // Use map to concurrently retrieve S3 URLs for video and thumbnail
      const s3Promises = sortedStories.map(async (story) => {
        // Retrieve story image URL from S3
        story.imageUrl = story.imageUrl ? await s3Retrieve(story.imageUrl) : null;

        // Retrieve reactions and related user info
        const reactions = await getDynamoRequestBuilder("Story_Reactions")
          .query("story_id", story.story_id)
          .useIndex("story_id-index")
          .scanIndexDescending()
          .exec();

        for (let i = 0; i < reactions.length; i++) {
          const reactorInfo = await pgQuery("SELECT username, profile_picture FROM users WHERE id=$1", reactions[i].user_id);
          if (reactorInfo.rows.length > 0) {
            reactorInfo.rows[0].profile_picture = reactorInfo.rows[0].profile_picture ? await s3Retrieve(reactorInfo.rows[0].profile_picture) : null;
            reactions[i].user = reactorInfo.rows[0];
          }
        }

        return {
          story_id: story.story_id,
          imageUrl: story.imageUrl,
          created_at: story.created_at,
          view_count: story.view_count,
          reactions: reactions
        };
      });

      // Wait for all promises to resolve
      const updatedStories = await Promise.all(s3Promises);

      const data = {
        user: {
          user_id: user_id,
          full_name: userDetail.full_name,
          username: userDetail.username,
          profile_picture: userDetail.profile_picture ? await s3Retrieve(userDetail.profile_picture) : null
        },
        stories: updatedStories
      };

      res.status(200).json({ data });
    } catch (err) {
      console.error("Error processing stories:", err);
      res.status(500).json({ message: "Internal Server Error" });
    }
  } catch (err) {
    console.error("Error retrieving user details:", err);
    next(err);
  }
});

/**
 * Retrieves stories of a given user
 * This endpoint needs a request header called 'Authorisation' with both the access token and the ID token 
 * 
 * @route GET /:user_id
 * @returns {status} - If successful, returns 200 and a JSON object containing story information such as story id, video URL, thumbnail URL, view count, created at, else returns 404 and a JSON object with message set to 'User not found'
 * @throws {Error} - If there is error retrieving stories
 */
router.get("/:userID",verifyTokens, rateLimiter(), inputValidator, async (req, res, next) => {
  try {
    const { payload } = req.body;
    const loggedInUser = payload.user_id;
    const user_id = req.params.userID;

    let reactionID=null;

    // Query to retrive user details from database
    const query = "SELECT full_name, username, profile_picture FROM users WHERE id=$1";
    const userDetails = await pgQuery(query, user_id);

    if (userDetails.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const userDetail = userDetails.rows[0];
    // //retrive all storeis realted to the user
    const userStories = await getDynamoRequestBuilder("Stories")
      .query("user_id", parseInt(user_id))
      .useIndex("user_id-created_at-index")
      .scanIndexDescending()
      .exec();
      
    const ONE_DAY = 1000 * 60 * 60 * 24; // One day in milliseconds

    //filter the story
    const filteredStories = userStories.filter((story) => {
      const timeDiff = Date.now() - Date.parse(story.created_at);
      return timeDiff < ONE_DAY;
    });

    //change the name of the sotry into url form
    const s3Promises = filteredStories.map(async (story) => {
      let reactionID = null;
      story.imageUrl = await s3Retrieve(story.imageUrl);
      const reactions = await getDynamoRequestBuilder("Story_Reactions")
        .query("story_id", story.story_id)
        .useIndex("story_id-index")
        .scanIndexDescending()
        .exec();

      // Find the reaction of the current user on the story
      for (let i = 0; i < reactions.length; i++) {
        if (reactions[i].user_id === loggedInUser) {
          reactionID = reactions[i].reaction_Id;
          break;
        }
      }
      story.reactionID=reactionID
      // story.thumbnail_url = await s3Retrieve(story.thumbnail_url);
      return story;
    });

    //wait for all the promises to be executed and store the urls in the updates Srotes varaible
    const updatedStories = await Promise.all(s3Promises);

    // user details and stories
    const data = {
      user:{      
        user_id: user_id,
        full_name: userDetail.full_name,
        user_name: userDetail.username,
        profile_picture: (userDetail.profile_picture!=null?await s3Retrieve(userDetail.profile_picture):null)},
      stories: [...updatedStories]

    };
    
    res.status(200).json({ data });
  } catch (err) {
    next(err);
  }
});

/**
 * User Posts a Story.
 *  This route allows users to create a new story,
 *  Including uploading a video and a thumbnail. 
 *  The video should be attached as the first file in req.files[0], 
 *  The thumbnail should be attached as the second file in req.files[1].
 * This endpoint needs a request header called 'Authorisation' with both the access token and the ID token 
 * 
 * @route POST /stories/:user_id
 * @returns {status} - If successful, returns 200 and a JSON object with status set to 'Story Posted', else returns 500 and a JSON object with message set to 'Story Post Failed'
 * @throws {Error} - If any errors occur during the creation process, including file uploads. The story won't be insert into dynamodb, then delete the uploaded filess.
 * @description 
 *       This route allows users to create a new story,
 *       Including uploading a image and a thumbnail. 
 *       The image should be attached as the first file in req.files[0], 
 *       The thumbnail should be attached as the second file in req.files[1].
 */
router.post("/", verifyTokens, rateLimiter(), inputValidator, upload.any(), async (req, res, next) => {
  try {
    let user = await getUserInfoFromIdToken(req.headers.authorisation.split(" ")[2])
    let user_id = user.user_id;

    const { store_in_memory } = req.body;

    const storeInMemory = store_in_memory || null;


    // Define S3 bucket paths for storing files
    // const S3_STORY_PATH = "stories/active/";
    const S3_IMAGE_PATH = "stories/active/";

    try {
      console.log(req.files[0].mimetype)
      // Upload the first file (image) and the second file (thumbnail) to an S3 bucket

      if (!req.files || !req.files[0].mimetype.startsWith("image/")) {
        return res.status(400).json({ message: "Invalid file format. Only images are allowed." });
      }

      const newImageName = await s3Upload(req.files[0], S3_IMAGE_PATH);

      const currentTime = new Date();
      const StorySchema = setStory(parseInt(user_id), newImageName, null, storeInMemory);

      // Insert the StorySchema object into the DynamoDB Stories table
      await getDynamoRequestBuilder("Stories").put(StorySchema).exec();
      // Respond with a success message
      res.status(200).json({ Status: "Image Posted" });



      // Respond with a success messages
      // res.status(200).json({ Status: "Story Posted" });

    } catch (err) {
      //if any error in the DynamoDB, delete the files from S3

      await s3Delete(req.file, S3_IMAGE_PATH);

      // Throw the error to the next error handler
      res.status(500).json({ message: "Story Post Failed" });
    }

  } catch (err) {
    // Throw the error to the next error handler
    next(err);
  }
});



/**
 * Deletes a user's story.
 *  This route allows the user to delete their story.
 *  It deletes the story from the DynamoDB and removes associated files from the S3 bucket.
 * This endpoint needs a request header called 'Authorisation' with both the access token and the ID token 
 * 
 * @route DELETE stories/story/story_id/user
 * @param {any} req.params.story_id - The ID of the story.
 * @returns {status} - If successful, returns 200 and a JSON object with status set to 'Story Deleted', else returns 404 and a JSON object with message set to 'Story not found' OR returns 500 and a JSON object with message set to 'Error deleting files from S3'
 * @throws {Error} - If any error occurs during the deletion process.
 */
router.delete("/story/:story_id/user", rateLimiter(), verifyTokens, inputValidator, async (req, res, next) => {
  try {
    // Parse the user_id from the request parameters
    const { story_id } = req.params;
    const { payload } = req.body;
    const user_id = payload.user_id;

    // Get the story from the Stories table for image and thumbnail URLs to delete from the S3 bucket
    const getStory = await getDynamoRequestBuilder("Stories")
      .query("user_id", parseInt(user_id))
      .exec();

    if (getStory.length === 0) {
      return res.status(404).json({ message: "Story not found" });
    }

    // get the image and thumbnail paths and story_id
    const { image_url, thumbnail_url, } = getStory[0];

    // Delete the image and thumbnail from the S3 bucket
    try {
      await Promise.all([
        s3Delete(image_url),
        s3Delete(thumbnail_url)
      ]);
    } catch (err) {
      // Handle errors here or log them for debugging
      console.error("Error deleting files from S3:", err);
      return res.status(500).json({ message: "Error deleting files from S3" });
    }

    // Delete the story from the Stories table
    await getDynamoRequestBuilder("Stories")
      .delete("user_id", parseInt(user_id))
      .withSortKey("story_id", story_id)
      .exec();


    res.status(200).json({ Status: "Story Deleted" });

  } catch (err) {
    // Handle errors and pass them to the next error handler
    next(err);
  }
});


/**
 * Posts a reaction to a story.
 * This endpoint needs a valid reaction id and story id 
 * 
 * @route POST stories/reaction/storyId/reactionId
 * @param {any} req.params.story_id - The ID of the story.
 * @param {any} req.params.reaction_Id - The ID of the reaction.
 * @returns {status} - If successful, returns 200 and a JSON object with status set to 'Reaction Submitted Succesfully', else returns 404 
 * @throws {Error} - If any error occurs during the deletion process.
 */

router.post("/reaction/:story_Id/:reaction_Id", async (req, res) => {
  try {
    // const { payload } = req.body;
    // const user_id = payload.user_id;
    const user_id = "2"
    const reactionId = parseInt(req.params.reaction_Id);
    const storyId = req.params.story_Id;

    // Check if the reaction ID is valid
    if (!checkReactionExists(reactionId)) {
      return res.status(401).json({ response: "Reaction ID doesn't exist" });
    }

    // Query DynamoDB to check if the story exists
    const storyExists = await getDynamoRequestBuilder("Stories")
      .query("story_id", storyId)
      .useIndex("story_id-index")
      .scanIndexDescending()
      .exec();

    if (storyExists.length < 1) {
      return res.status(400).json({ response: "Story doesn't exist" });
    }

    // Check for duplicate reactions by the same user on the same story
    const duplicateReactions = await getDynamoRequestBuilder("Story_Reactions")
      .query("story_id", storyId)
      .useIndex("story_id-index")
      .scanIndexDescending()
      .exec();

    for (let reaction of duplicateReactions) {
      if (reaction.user_id === user_id) {
        return res.status(400).json({ response: "User has already reacted" });
      }
    }

    // Create the reaction schema
    const reactionSchema = setStoryReactions(storyId, user_id, reactionId);

    // Insert the reaction schema into the DynamoDB Story_Reactions table
    await getDynamoRequestBuilder("Story_Reactions").put(reactionSchema).exec();

    // Respond with a success message
    res.status(200).json({ status: "Reaction Submitted Successfully" });
  } catch (err) {
    // Log the error and respond with a 500 status code
    console.error(err);
    return res.status(500).json({ error: err });
  }
});



/**
 * Gets a reaction to a story.
 * This endpoint needs a valid story id 
 * 
 * @route GET stories/reaction/story/storyId
 * @param {any} req.params.story_id - The ID of the story.
 * @returns {status} - If successful, returns 200 and a JSON object with status set to an array of users
 */
router.get("/reaction/story/:storyId", verifyTokens, async (req, res) => {
  try {
    const { payload, filterByCurrentUser } = req.body
    const { user_id } = payload

    // Destructure the storyId from the request body
    const storyId = req.params.storyId;



    // Query DynamoDB to get reactions for the specified storyId
    const storyReactions = await getDynamoRequestBuilder("Story_Reactions")
      .query("story_id", storyId)
      .useIndex("story_id-index")
      .scanIndexDescending()
      .exec();

    // Iterate over each reaction to fetch user details
    for (let i = 0; i < storyReactions.length; i++) {
      const userDetailsResult = await pgQuery(
        "SELECT full_name, profile_picture FROM users WHERE id=$1", storyReactions[i].user_id
      );
      const userDetails = userDetailsResult.rows[0];

      // If the user has a profile picture, retrieve it from S3
      if (userDetails && userDetails.profile_picture) {
        userDetails.profile_picture = await s3Retrieve(userDetails.profile_picture);
      }

      // Attach user details to the reaction
      storyReactions[i].user = userDetails;
      if (filterByCurrentUser && storyReactions[i].user_id == user_id) {
        return res.status(200).json({ reactions: storyReactions[i] });
      }
    }

    // Respond with the reactions
    return res.status(200).json({ reactions: storyReactions });
  } catch (err) {
    // Log the error and respond with a 500 status code
    console.error(err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});





export default router;
