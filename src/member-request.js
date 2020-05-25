/**
 * This worker script is used to send the form values from the "Join 48 IX" form on
 * the main website (48ix.net) to a predefined Slack channel to handle such requests.
 *
 * The handler expects JSON data in the request body, transforms that data into a
 * Slack webhook, and posts the message to the channel.
 */
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

// Slack webhook URL, installed to global scope via Cloudflare environment variable
const WEBHOOK_URL = SLACK_WEBHOOK_URL;

/**
 * Construct a Slack message.
 * @param {Object} cf Cloudflare `cf` object
 * @param {Header} headers fetch Headers from inbound event
 * @param {string} memberName Organization Name
 * @param {string} memberAsn Organization ASN
 * @param {string} contactName Organization Contact Name
 * @param {string} facilityName 48 IX Facility Name
 * @param {number} portSpeed Port Speed, 1 or 10
 * @param {number} timestamp UNIX timestamp
 */
const makeMessage = (
  cf,
  headers,
  memberName,
  memberAsn,
  contactName,
  facilityName,
  portSpeed,
  timestamp,
) => ({
  attachments: [
    {
      fallback: `${memberName} (AS${memberAsn}) @ ${facilityName}`,
      color: '#47f2ff',
      pretext: 'New Member Request',
      title: memberName,
      title_link: `https://peeringdb.com/asn/${memberAsn}`,
      text: `AS${memberAsn}`,
      fields: [
        {
          title: 'Contact Name',
          value: contactName,
          short: false,
        },
        {
          title: 'Facility',
          value: facilityName,
          short: true,
        },
        {
          title: 'Desired Port Speed',
          value: `${portSpeed} Gbps`,
          short: true,
        },
        {
          title: 'Country',
          value: cf.country,
          short: true,
        },
        {
          title: 'ASN',
          value: `AS${cf.asn}`,
          short: true,
        },
        {
          title: 'Cloudflare Location',
          value: cf.colo,
          short: true,
        },
        {
          title: 'IP',
          value: headers.get('CF-Connecting-IP'),
          short: true,
        },
        {
          title: 'User Agent',
          value: headers.get('User-Agent'),
          short: false,
        },
      ],
      ts: timestamp,
    },
  ],
});

/**
 * Worker request object.
 * @param {Request} request
 */
const handleRequest = async request => {
  // Destructure request body as JSON.
  const {
    memberName,
    memberAsn,
    contactName,
    facilityName,
    portSpeed,
    timestamp,
  } = await request.json();

  // Construct a Slack message from the input data.
  const message = makeMessage(
    request.cf || {},
    request.headers || {},
    memberName,
    memberAsn,
    contactName,
    facilityName,
    portSpeed,
    timestamp,
  );

  // Send the constructed Slack message.
  const slackRes = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json;charset=UTF-8' },
    body: JSON.stringify(message),
  });

  // Return Slack's JSON response & status code with CORS headers.
  return new Response(JSON.stringify(slackRes.json()), {
    status: slackRes.status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'content-type': 'application/json;charset=UTF-8',
    },
  });
};
