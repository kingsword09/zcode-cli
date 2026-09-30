The certificate and private key in this directory are public test fixtures for
the loopback HTTPS model server. They are not production credentials. Only the
isolated test child process trusts this certificate through NODE_EXTRA_CA_CERTS.
HTTPS exercises the native Coding Plan signing path without disabling TLS checks.
