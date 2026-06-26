/**
 * Cognito Pre-SignUp Trigger for Native Account Linking
 *
 * When a user signs up via Google OAuth and an account with that email already exists
 * as a Cognito password user, this trigger calls AdminLinkProviderForUser to link
 * the Google identity to the existing user. Both login methods will then return the
 * same cognito_user_id — no database changes required.
 */

const { CognitoIdentityProviderClient, ListUsersCommand, AdminLinkProviderForUserCommand } = require('@aws-sdk/client-cognito-identity-provider');

const cognitoClient = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || 'us-west-2' });

exports.handler = async (event) => {
  console.log('Pre-SignUp trigger event:', JSON.stringify(event, null, 2));

  const { triggerSource, userName, userPoolId, request } = event;

  // Only handle Google / external provider signups
  if (triggerSource !== 'PreSignUp_ExternalProvider') {
    return event;
  }

  const email = request.userAttributes.email;
  console.log(`External provider signup — email: ${email}, userName: ${userName}`);

  try {
    // Find the existing Cognito password user with this email
    const listResult = await cognitoClient.send(new ListUsersCommand({
      UserPoolId: userPoolId,
      Filter: `email = "${email}"`,
    }));

    const passwordUser = listResult.Users?.find(
      u => u.UserStatus !== 'EXTERNAL_PROVIDER'
    );

    if (!passwordUser) {
      console.log('No existing password user found — allowing normal signup to proceed');
      return event;
    }

    console.log(`Found existing password user: ${passwordUser.Username} — linking Google identity`);

    // Determine the provider name and provider-side username from the trigger userName.
    // Cognito formats it as "Google_<google-sub>" for Google signups.
    const [providerName, ...rest] = userName.split('_');
    const providerUserId = rest.join('_');

    await cognitoClient.send(new AdminLinkProviderForUserCommand({
      UserPoolId: userPoolId,
      DestinationUser: {
        ProviderName: 'Cognito',
        ProviderAttributeName: 'Username',
        ProviderAttributeValue: passwordUser.Username,
      },
      SourceUser: {
        ProviderName: providerName,           // e.g. "Google"
        ProviderAttributeName: 'Cognito_Subject',
        ProviderAttributeValue: providerUserId, // e.g. the Google sub
      },
    }));

    console.log(`Successfully linked Google identity to password user ${passwordUser.Username}`);

    // Returning event allows the signup to proceed; Cognito will redirect the
    // federated session to the linked (existing) user automatically.
    return event;

  } catch (error) {
    console.error('Pre-SignUp trigger error:', error);
    // Do not block sign-in if linking fails — log and proceed.
    return event;
  }
};
