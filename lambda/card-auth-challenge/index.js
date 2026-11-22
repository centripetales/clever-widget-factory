/**
 * Cognito custom-auth triggers for NFC card sign-in (Define, Create, Verify).
 *
 * The card-login endpoint checks the card's secret and hands the page a
 * short-lived signed proof. The page answers Cognito's challenge with that proof,
 * and Verify only checks the proof's signature and that it is for this user, so
 * this Lambda needs no database. Password and Google sign-in never use custom auth.
 */
const jwt = require('jsonwebtoken');

const AUDIENCE = 'card-login';

exports.handler = async (event) => {
  switch (event.triggerSource) {
    case 'DefineAuthChallenge_Authentication': {
      const session = event.request.session || [];
      const last = session[session.length - 1];
      if (last && last.challengeName === 'CUSTOM_CHALLENGE' && last.challengeResult === true) {
        event.response.issueTokens = true;
        event.response.failAuthentication = false;
      } else if (session.length >= 3) {
        event.response.issueTokens = false;
        event.response.failAuthentication = true;
      } else {
        event.response.issueTokens = false;
        event.response.failAuthentication = false;
        event.response.challengeName = 'CUSTOM_CHALLENGE';
      }
      return event;
    }

    case 'CreateAuthChallenge_Authentication':
      event.response.publicChallengeParameters = {};
      event.response.privateChallengeParameters = {};
      event.response.challengeMetadata = 'CARD_PROOF';
      return event;

    case 'VerifyAuthChallengeResponse_Authentication': {
      try {
        const claims = jwt.verify(event.request.challengeAnswer, process.env.JWT_SECRET, { audience: AUDIENCE });
        event.response.answerCorrect = claims.sub === event.request.userAttributes.sub;
      } catch {
        event.response.answerCorrect = false;
      }
      return event;
    }

    default:
      return event;
  }
};
