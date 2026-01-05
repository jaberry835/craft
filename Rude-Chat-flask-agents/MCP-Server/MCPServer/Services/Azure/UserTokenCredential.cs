using Azure;
using Azure.Core;

namespace MCPServer.Services.Azure;

/// <summary>
/// Custom TokenCredential that uses a pre-acquired access token
/// </summary>
public class UserTokenCredential : TokenCredential
{
    private readonly string _accessToken;

    public UserTokenCredential(string accessToken)
    {
        _accessToken = accessToken ?? throw new ArgumentNullException(nameof(accessToken));
    }

    public override AccessToken GetToken(TokenRequestContext requestContext, CancellationToken cancellationToken)
    {
        // Return the user's access token
        // Note: In a production environment, you should validate the token scope and expiry
        return new AccessToken(_accessToken, DateTimeOffset.UtcNow.AddHours(1));
    }

    public override ValueTask<AccessToken> GetTokenAsync(TokenRequestContext requestContext, CancellationToken cancellationToken)
    {
        return new ValueTask<AccessToken>(GetToken(requestContext, cancellationToken));
    }
}
