package main

import (
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

// Reissue from the same test key to distinguish hostname/expiry validation
// failures from an untrusted signing key.
func testCertificate(t *testing.T, id tls.Certificate, change func(*x509.Certificate)) tls.Certificate {
	t.Helper()
	tpl := *id.Leaf
	change(&tpl)
	key := id.PrivateKey.(*ecdsa.PrivateKey)
	der, err := x509.CreateCertificate(rand.Reader, &tpl, &tpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key, Leaf: leaf}
}

func saveTestCertificate(t *testing.T, state string, id tls.Certificate) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(state, "front-cert.pem"), pem.EncodeToMemory(&pem.Block{
		Type: "CERTIFICATE", Bytes: id.Certificate[0],
	}), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestHealthCheckVerifiesFrontCertificate(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer backend.Close()
	upstream, _ := url.Parse(backend.URL)
	for _, scenario := range []string{"trusted", "wildcard", "untrusted", "wrong hostname", "expired", "missing trust", "invalid trust", "redirect"} {
		t.Run(scenario, func(t *testing.T) {
			state := t.TempDir()
			id, err := loadOrCreateIdentity(state, nil)
			if err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "untrusted":
				id, err = loadOrCreateIdentity(t.TempDir(), nil)
				if err != nil {
					t.Fatal(err)
				}
			case "wrong hostname":
				id = testCertificate(t, id, func(cert *x509.Certificate) { cert.DNSNames = []string{"other.example.org"} })
				saveTestCertificate(t, state, id)
			case "expired":
				id = testCertificate(t, id, func(cert *x509.Certificate) {
					cert.NotBefore = time.Now().Add(-2 * time.Hour)
					cert.NotAfter = time.Now().Add(-time.Hour)
				})
				saveTestCertificate(t, state, id)
			case "missing trust":
				if err := os.Remove(filepath.Join(state, "front-cert.pem")); err != nil {
					t.Fatal(err)
				}
			case "invalid trust":
				if err := os.WriteFile(filepath.Join(state, "front-cert.pem"), []byte("invalid"), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			front := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if scenario == "redirect" {
					http.Redirect(w, r, backend.URL, http.StatusFound)
					return
				}
				w.WriteHeader(http.StatusOK)
			}))
			front.TLS = &tls.Config{Certificates: []tls.Certificate{id}, MinVersion: tls.VersionTLS12}
			front.StartTLS()
			defer front.Close()
			addr := front.Listener.Addr().String()
			if scenario == "wildcard" {
				_, port, _ := net.SplitHostPort(addr)
				addr = net.JoinHostPort("0.0.0.0", port)
			}
			got := healthcheck(config{Addr: addr, Upstream: upstream, State: state})
			want := 1
			if scenario == "trusted" || scenario == "wildcard" {
				want = 0
			}
			if got != want {
				t.Fatalf("healthcheck = %d, want %d", got, want)
			}
		})
	}
}

func TestHealthCheckRejectsUntrustedHTTPSConsole(t *testing.T) {
	state := t.TempDir()
	base, _, _ := start(t, map[string]string{"MV_TLS_STATE": state})
	front, _ := url.Parse(base)
	backend := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer backend.Close()
	upstream, _ := url.Parse(backend.URL)
	if healthcheck(config{Addr: front.Host, Upstream: upstream, State: state}) == 0 {
		t.Fatal("untrusted HTTPS Console was reported healthy")
	}
}

func TestLegacyCertificateGainsLocalIdentityWithoutChangingPin(t *testing.T) {
	state := t.TempDir()
	names := []string{"dune.example.org", "203.0.113.7"}
	id, err := loadOrCreateIdentity(state, names)
	if err != nil {
		t.Fatal(err)
	}
	legacy := testCertificate(t, id, func(cert *x509.Certificate) { cert.DNSNames = []string{"dune.example.org"} })
	saveTestCertificate(t, state, legacy)
	updated, err := loadOrCreateIdentity(state, names)
	if err != nil {
		t.Fatal(err)
	}
	if pinOf(updated.Leaf) != pinOf(legacy.Leaf) {
		t.Fatal("certificate upgrade changed the existing fingerprint")
	}
	if err := updated.Leaf.VerifyHostname("localhost"); err != nil {
		t.Fatal(err)
	}
	if err := updated.Leaf.VerifyHostname("dune.example.org"); err != nil {
		t.Fatal(err)
	}
	if err := updated.Leaf.VerifyHostname("203.0.113.7"); err != nil {
		t.Fatal(err)
	}
	again, err := loadOrCreateIdentity(state, append(names, "LOCALHOST", "localhost"))
	if err != nil || !slices.Equal(again.Certificate[0], updated.Certificate[0]) {
		t.Fatal("duplicate localhost names caused unnecessary certificate renewal")
	}
}
