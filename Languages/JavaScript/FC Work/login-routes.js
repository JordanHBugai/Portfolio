/* For login system routes */
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserAttribute,
  CognitoUserSession,
  CognitoAccessToken,
  CognitoIdToken,
  CognitoRefreshToken,
} from "amazon-cognito-identity-js";
import { hash } from "bcrypt";
import { Router } from "express";

import rateLimiter from "../middleware/rate_limiter.js";
import inputValidator from "../middleware/input_validator.js";

import { cognitoUserPool } from "../config/cognito.js";
import { pgQuery, s3Retrieve } from "../functions/general_functions.js";
import emailOrUsername from "../middleware/auth_options.js";
import { parseHeader } from "../functions/cognito_functions.js";
import { verifyTokens } from "../middleware/verify.js";

const router = Router();

/* Testing Login Route */
router.get("/testing", async (req, res) => {
  try {
    res.json({ Testing: "Working Login" });
  } catch (err) {
    console.error(err.message);
    res.json(err.message);
  }
});

router.get("psql_schema", async (req, res) => {
  const result = await pgQuery("SELECT table_schema, table_name FROM information_schema.tables");
  console.log(result);
});

/**
 * Sign up a user
 *
 * @route POST /login/signup
 * @body {string} req.body.username - Users Username
 * @body {string} req.body.email - Users email
 * @body {string} req.body.password - Users password
 * @returns {status} - A status indicating successful sign up returns 201, unsuccessful returns 400 for incomplete information or user associated with pre-existing email
 * @throws {Error} - If there are errors Dont create user (500)
 */


router.post("/signup", inputValidator, rateLimiter(), async (req, res) => {

  // Extract necessary input fields from request body
  const { username, email, password, full_name } = req.body;

  // Check if all necessary input fields are provided
  if (!(username && email && password && full_name)) {
    return res.status(400).json({ message: "Necessary input fields not given in request" });
  }

  // Initialize an array to store Cognito user attributes
  const attributeArray = [];

  // Hash the user's password
  const passwordHashed = await hash(password, 10);

  // Add email attribute to attributeArray for Cognito signup
  attributeArray.push(new CognitoUserAttribute({ Name: "email", Value: email }));

  // Checks if email already exists in database
  try {
    const checkEmail = await pgQuery("SELECT id from users WHERE email=$1", email); // query to check if duplicate email does exist in PG
    if (checkEmail.rows.length > 0) {
      return res.status(400).json({ message: "User with email already exists" });
    }
  } catch (error) {
    return res.status(500).json({ message: error });
  }

  let user_id;

  // Insert user data into the database
  try {
    const verified = false;
    const insertQuery = await pgQuery("INSERT INTO users (username, email, password, full_name, verified) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      username, email, passwordHashed, full_name, verified);
    user_id = insertQuery.rows[0].id;
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }

  // Add custom user id attribute to attributeArray for Cognito signup
  attributeArray.push(new CognitoUserAttribute({ Name: "custom:id", Value: user_id.toString() }));

  // Sign up user using Cognito
  cognitoUserPool.signUp(username, password, attributeArray, null, async (err, result) => {
    if (err) {
      // If signup fails, delete the user from the database
      await pgQuery("DELETE FROM users WHERE username = $1", username);
      return res.status(400).json({ message: err.message });
    }

    // Return successful signup response
    return res.status(201).json({
      user_id: user_id,
      username: username,
      verification_status: "not verified",
      email: email,
      full_name: full_name,
      session: null
    });
  });
});

/**
 * Verify a users email using verification code after sign up.
 * 
 * @route POST /login/confirm_verification
 * @body {string} req.body.username - Users Username
 * @body {string} req.body.verification_code - Verification code from users email
 * @body {string} req.body.password - password, for logging in user after confirmation
 * @returns {status} - A successful status indicates code verfified, returns 200 with JSON object
 * @throws {Error} - If there are errors dont verify code, returns 400
 */
router.post("/confirm_verification", inputValidator, rateLimiter(), (req, res) => {

  // Extract necessary input fields from request body
  const { username, password, verification_code } = req.body;

  // Create user data object for Cognito user
  const userData = {
    Username: username,
    Pool: cognitoUserPool,
  };

  // Initialize Cognito user object
  const cognitoUser = new CognitoUser(userData);

  // Confirm user registration with verification code
  cognitoUser.confirmRegistration(verification_code, true, async (err, result) => {
    if (err) {
      // Handle error if confirmation fails
      return res.status(400).json({ message: err.message });
    }

    // Update user verification status in the database
    try {
      const verified = true;
      await pgQuery("UPDATE users SET verified = $1 WHERE username = $2", verified, username);
    } catch (error) {
      // Handle error if database update fails
      res.status(400).json({ message: error.message });
    }

    // Authenticate user using Cognito
    const authenticationDetails = new AuthenticationDetails({
      Username: username,
      Password: password
    });

    cognitoUser.authenticateUser(authenticationDetails, {
      onSuccess: async (result) => {
        // Retrieve user data from the database
        const user = await pgQuery("SELECT id, username, profile_picture FROM users WHERE username = $1", username);
        // Get tokens from Cognito user session
        const signInUserSession = cognitoUser.getSignInUserSession();
        const idToken = signInUserSession.getIdToken().getJwtToken();
        const accessToken = signInUserSession.getAccessToken().getJwtToken();
        const refreshToken = signInUserSession.getRefreshToken().getToken();

        // Return successful login response with user data and tokens
        res.status(200).json({
          header: "user logged in",
          message: "user email verified successfully",
          user: user.rows[0],
          access_token: accessToken,
          id_token: idToken,
          refresh_token: refreshToken
        });
      },
      onFailure: (err) => {
        // Handle authentication failure
        return res.status(400).json({ message: err.message });
      }
    });
  });
});


/**
 * Send another verification code to user
 *
 * @route POST /login/resend_verification_code
 * @body {string} req.body.username - Users Username
 * @returns {status} - A successful status indicates code resent, returns 200 and a JSON object
 * @throws {Error} - If there are errors dont send another verififcation code, returns 400
 */
router.post("/resend_verification_code", inputValidator, rateLimiter(), (req, res) => {
  // Extract username from request body
  const { username } = req.body;

  // Create user data object for Cognito user
  const userData = {
    Username: username,
    Pool: cognitoUserPool,
  };

  // Initialize Cognito user object
  const cognitoUser = new CognitoUser(userData);

  // Resend confirmation code to user's email
  cognitoUser.resendConfirmationCode((err, result) => {
    if (err) {
      // Handle error if resend fails
      return res.status(400).json({ message: err.message });
    }
    // Return success message if code is resent successfully
    res.status(200).json({
      header: "User email is not confirmed",
      message: "new code sent successfully"
    });
  });
});

/**
 * Allows a user to sign in to their account
 *
 * @route POST /login/signin
 * @body {string} req.body.username - Users Username
 * @body {string} req.body.email - the user's email address. Either usename or email can be used.
 * @body {string} req.body.password - Users password
 * @returns {status} - A successful status indicates successful sign in, returns 200 and a JSON object
 * @throws {Error} - If there are errors dont sign user in, returns 400 and a JSON with associated error message
 */
router.post("/signin", inputValidator, rateLimiter(), emailOrUsername(), (req, res) => {
  // Extract username and password from request body
  const { username, password } = req.body;

  // Create user data object for Cognito user
  const userData = {
    Username: username,
    Pool: cognitoUserPool
  };

  // Initialize Cognito user object
  const cognitoUser = new CognitoUser(userData);

  // Create authentication details object
  const authenticationDetails = new AuthenticationDetails({
    Username: username,
    Password: password
  });

  // Authenticate user using Cognito
  cognitoUser.authenticateUser(authenticationDetails, {
    onSuccess: async (result) => {
      // Retrieve user data from the database
      const user = await pgQuery("SELECT id, username, profile_picture, full_name FROM users WHERE username = $1", username);
      // signInUserSession is an instance of CognitoUserSession
      // these return object instances, not just strings of the tokens.
      const signInUserSession = cognitoUser.getSignInUserSession();

      const idToken = signInUserSession.getIdToken().getJwtToken();
      const accessToken = signInUserSession.getAccessToken().getJwtToken();
      const refreshToken = signInUserSession.getRefreshToken().getToken();
      if (user.rows[0].profile_picture != null) {
        user.rows[0].profile_picture = await s3Retrieve(user.rows[0].profile_picture)
      }


      // user id is in idToken.payload['custom:id'] 
      // Return successful sign in response with user data and tokens      
      res.status(200).json({
        user: user.rows[0],
        access_token: accessToken,
        id_token: idToken,
        refresh_token: refreshToken,
      });
    },
    // Handle different failure scenarios
    onFailure: (err) => {
      //Handle case where user is not verified
      if (err.message == "User is not confirmed.") {
        // Resend verification code if user is not verified
        cognitoUser.resendConfirmationCode((err, result) => {
          if (err) {
            return res.status(400).json({ message: err.message });
          }
          res.status(400).json({
            message: "User is not verified",
            description: "new verification code email sent"
          });
        });
      } else if (err.code == "UserNotFoundException") {
        // Handle case where user is not found
        res.status(400).json({
          header: "user not found",
          message: "User does not exist"
        });
      } else {
        // Handle other sign in errors
        res.status(400).json({
          header: "sign in error",
          message: err.message
        });
      }
    }
  });
});

/**
 * Sign a user out
 *
 * @route POST /login/signout
 * @body {string} req.body.username - the username of the user.
 * @returns {status} - A successful status means sign out successful, returns 200 and a JSON object with a success message
 * @throws {Error} - If there are errors dont sign a user out, returns 404 and a JSON object with a message saying user could not be signed out
 */
///@dev this endpoint will need the verify endpoint, to only allow a signed in user to make a sign out request.
router.post("/signout", rateLimiter(), (req, res) => {
  // Extract username from request body
  const { username } = req.body;

  // Create user data object for Cognito user
  const userData = {
    Username: username,
    Pool: cognitoUserPool
  };

  // Initialize Cognito user object
  const cognitoUser = new CognitoUser(userData);

  // Check if cognitoUser is not null, indicating that a user session exists (i.e., the user is logged in)
  if (cognitoUser != null) {
    // Sign out the user
    cognitoUser.signOut((err, result) => {
      if (err) {
        // Handle error if sign out fails
        return res.status(400).json(err.message);
      }
    });
    // Return success message if user is signed out
    return res.status(200).json({
      message: "user successfully logged out"

    });
  } else {
    // Return error message if username is not found
    return res.status(404).json({
      message: "Username is not found: user could not be signed out.",
    });
  }
});

/**
 * Changes a users password from old to new
 *
 * @route POST /login/change_password
 * @header {CognitoAccessToken} - the user's access token
 * @header {CognitoIdToken} - the user's id token
 * @body {string} req.body.old_password - Users old password
 * @body {string} req.body.new_password - Users new password
 * @returns {status} - A successful status indicates password successfully changed, returns 201 and a JSON object with a success message
 * @throws {Error} - If there are errors dont change the users passwords, returns 400 with an error message
 */
router.post("/change_password", inputValidator, rateLimiter(), (req, res) => {
  // Extract username, old password, and new password from request body
  const { username, old_password, new_password } = req.body;

  // Create user data object for Cognito user
  const userData = {
    Username: username,
    Pool: cognitoUserPool
  };

  // Extract authorization header from request
  const authorisation = req.header["Authorisation"];
  try {
    // Parse access token and id token from authorization header
    const { access_token, id_token } = parseHeader(authorisation);

    // Create Cognito access token and id token objects
    const cognitoAccessToken = new CognitoAccessToken({ AccessToken: access_token });
    const cognitoIdToken = new CognitoIdToken({ IdToken: id_token });

    /* Below sets the session for the user using tokens: effectively 'signing the user in' for this action which requires the user to be 
    authenticated. For this, the id token and the access token are required in the request header.
    */
    // Create session data object
    const sessionData = {
      IdToken: cognitoIdToken,
      AccessToken: cognitoAccessToken,
      RefreshToken: null,
      ClockDrift: null,
    };

    // Create Cognito user session
    const cognitoUserSession = new CognitoUserSession(sessionData);

    // Initialize Cognito user object
    const cognitoUser = new CognitoUser(userData);

    // Set the sign-in user session for the Cognito user
    cognitoUser.setSignInUserSession(cognitoUserSession);

    // Change user password
    cognitoUser.changePassword(old_password, new_password, (err, result) => {
      if (err) {
        // Handle error if password change fails
        return res.status(400).json({ message: err.message });
      }
      return res
        .status(201)
        .json({ message: "password changed successfully" });
    });

  } catch (error) {
    // Handle error if parsing tokens fails
    res.status(400).json({ message: error.message });
  }

});

/**
 * Sends a user a forgot password verification code
 *
 * @route POST /login/forgot_password/verification_code
 * @body {string} req.body.username - Users Username
 * @returns {status} - A successful status indicates code is sent, returns 200 and a JSON object with a message indicating verification code sent 
 * @throws {Error} - If there are errors dont send a code, returns 400 with associated error message
 */
router.post("/forgot_password/verification_code", inputValidator, rateLimiter(), emailOrUsername(), async (req, res) => {
  // Extract username from request body
  const { username } = req.body;

  // Create user data object for Cognito user
  const userData = {
    Username: username,
    Pool: cognitoUserPool,
  };

  // Initialize Cognito user object
  const cognitoUser = new CognitoUser(userData);

  // Send forgot password verification code
  cognitoUser.forgotPassword({
    onSuccess: (data) => {
      // Return success message if verification code is sent successfully
      res.status(200).json({ message: "Verification code sent" });
    },
    onFailure: (err) => {
      // Handle failure to send verification code
      res.status(400).json({ message: err.message });
    },
  });
}
);

/**
 * Uses verification code to  change the password
 *
 * @route POST /login/forgot_password_code/new_password
 * @body {string} req.body.username - Users Username
 * @body {string} req.body.verification_code - Verification code that was sent
 * @body {string} req.body.newPassword - Users new password
 * @returns {status} - A successful status indicates new password has been set, returns 201 and a JSON object with successful password reset message
 * @throws {Error} - If there are errors dont chagne the password, returns 400 with associated error message
 */
router.post("/forgot_password_code/new_password", inputValidator, rateLimiter(), (req, res) => {
  // Extract username, verification code, and new password from request body
  const { username, verification_code, new_password } = req.body;

  // Create user data object for Cognito user
  const userData = {
    Username: username,
    Pool: cognitoUserPool,
  };

  // Initialize Cognito user object
  const cognitoUser = new CognitoUser(userData);

  // Confirm password reset using verification code
  cognitoUser.confirmPassword(verification_code, new_password, {
    onSuccess() {
      // Return success message if password reset is successful
      res.status(201).json({ message: "password reset successfully" });
    },
    onFailure(err) {
      // Handle failure to reset password
      res.status(400).json({ message: err });
    },
  });
}
);

/**
 * Global sign out: invalidates all user tokens on all devices.
 *
 * @route POST /login/global_signout
 * @body req.body.username - the user's username
 * @returns {status} - A successful status indicates user is signed out on all devices he is logged in on, returns 200 with global sign-out message
 * @throws {Error} - If there are errors dont sign user out on any device, returns 400 with associated error message
 */
router.post("/global_signout", rateLimiter(), async (req, res) => {
  // Extract username from request body
  const { username } = req.body;

  // Create user data object for Cognito user
  const userData = {
    Username: username,
    Pool: cognitoUserPool,
  };

  // Get the authorisation header and tokens
  const authorisation = req.header["Authorisation"];
  try {
    // Parse access token and id token from authorization header
    const { access_token, id_token } = parseHeader(authorisation);

    // Create Cognito access token and id token objects
    const cognitoAccessToken = new CognitoAccessToken({ AccessToken: access_token });
    const cognitoIdToken = new CognitoIdToken({ IdToken: id_token });

    // Create session data object
    const sessionData = {
      IdToken: cognitoIdToken,
      AccessToken: cognitoAccessToken,
      RefreshToken: null,
      ClockDrift: null,
    };

    // Create Cognito user session
    const cognitoUserSession = new CognitoUserSession(sessionData);

    // Initialize Cognito user object
    const cognitoUser = new CognitoUser(userData);

    // Set the sign-in user session for the Cognito user
    cognitoUser.setSignInUserSession(cognitoUserSession);

    // Perform global sign out
    cognitoUser.globalSignOut({
      onSuccess: (result) => {
        // Return success message if global sign out is successfu
        res.status(200).json("User signed out globally");
      },
      onFailure: (err) => {
        // Handle failure of global sign out
        res.status(400).json(err.message);
      }
    });
  } catch (err) {
    // Handle error if parsing tokens fails
    return res.status(400).json(err.message);
  }
});

/**
 * Use the refresh token to get a new access token, if possible.
 * 
 * @route POST /login/refresh_token
 * @header req.header['Refresh-Token'] - the refresh token as a string
 * @body req.body.username - the username of the user making the request
 * @returns {status} -  a successful status indicates that the refresh token has been successfully used to refresh the user's session and generate new tokens.
 *  The tokens (access, refresh and id) are returned as CognitoUserSession() object. Returns 200 and a JSON object with token data, header, and message
 * @throws {Error} - If the refresh token is not valid, or there is another internal error, returns 400 with associated error message
 */

router.post("/refresh_session", rateLimiter(10, 1), async (req, res) => {
  // Extract username and refresh token from request body
  const { username, refresh_token } = req.body;

  // Check if refresh token is provided
  if (refresh_token) {
    // first check if refresh token is valid: verify the token
    // Create Cognito refresh token object
    const cognitoRefreshToken = new CognitoRefreshToken({ RefreshToken: refresh_token });
    try {
      // Create user data object for Cognito user
      const userData = {
        Username: username,
        Pool: cognitoUserPool,
      };

      // Initialize Cognito user object
      const cognitoUser = new CognitoUser(userData);

      // Refresh user session using refresh token
      cognitoUser.refreshSession(cognitoRefreshToken, (err, result) => {
        if (err) {
          // Handle error if session refresh fails
          return res.status(400).json(err.message);
        }

        // if user_id not in payload, we can just use a lookup in psql with username.
        // if successful, the user's new tokens are returned as a string
        return res.status(200).json({
          header: "Session refresh successful",
          message: "User signed in",
          access_token: result.getAccessToken().getJwtToken(),
          id_token: result.getIdToken().getJwtToken(),
          refresh_token: result.getRefreshToken().getToken()
        });
      });
    } catch (err) {
      // Handle error if session refresh fails
      res.status(400).json({
        error: err.message,
        message: "Refresh token invalid. Please re-authenticate."
      });
    }
  } else {
    // Return error if refresh token is not provided
    res.status(400).json({ message: "Refresh token not provided" });
  }
});

/**
 * This endpoint needs a request header called 'Authorisation' with both the access token and the ID token 
 */
router.get("/test_tokens", verifyTokens, (req, res) => {
  console.log(req.body);
  res.status(200).json(req.body);
});
export default router;
