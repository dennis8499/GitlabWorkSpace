Feature: Connect to a custom GitLab URL

  @automated @SCN-URL-001
  Scenario Outline: Connect to an HTTP GitLab server at a custom location
    Given a GitLab server at "<url>"
    When I connect with a token
    Then the connection stores the normalized URL "<normalized>"
    And GitLab receives the token at "<api-url>"
    And every API request stays on the configured origin

    Examples:
      | url                                        | normalized                               | api-url                                                                  |
      | http://gitlab.internal.test:8929/gitlab/   | http://gitlab.internal.test:8929/gitlab  | http://gitlab.internal.test:8929/gitlab/api/v4/user                      |
      | http://192.168.10.40:8929/                 | http://192.168.10.40:8929                | http://192.168.10.40:8929/api/v4/user                                     |

  @automated @SCN-URL-002
  Scenario Outline: Reject invalid URL components before making a request
    Given an invalid GitLab URL "<url>"
    When I connect with a token
    Then the connection rejects the URL without making a request

    Examples:
      | url                                  |
      | ftp://gitlab.internal.test           |
      | http://gitlab.internal.test?         |
      | http://gitlab.internal.test#         |
      | http://@gitlab.internal.test         |
      | http://:@gitlab.internal.test        |
      | http:\@gitlab.internal.test          |
      | http:////@gitlab.internal.test       |

  @automated @SCN-URL-003
  Scenario: Do not store a token rejected by GitLab
    Given a GitLab server at "http://gitlab.internal.test:8929/gitlab"
    And the GitLab server rejects the token
    When I connect with a token
    Then the token is rejected and not stored
